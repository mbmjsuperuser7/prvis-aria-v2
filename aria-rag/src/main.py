"""
aria-rag — RAG ingestion and search service.

Two responsibilities:
1. Ingest — chunk documents, embed them, upsert into Qdrant.
   Sources:
     - knowledge/standards/   — ISO 27001, NIS2, SOC2, ITIL, IEC 62443, NIST CSF
     - knowledge/tools/       — tool registry, skill docs
     - aria-ccf/playbooks/    — change management, incident response, vulnerability mgmt
     - audit/                 — ACiDF files (user profile, discovery history)
   Runs at startup then watches for changes every 60 seconds.

2. Search — HTTP endpoint called by ruflo orchestrator when an LLM needs context.
   POST /search  { query, cid, top_k }
   Returns top_k relevant chunks from Qdrant.
   cid used to scope ACiDF search to this user's profile.

Embedding model: nomic-embed-text via Ollama (CPU, lightweight).
Vector store: Qdrant (disk-backed, persistent).
Chunk size: 512 tokens, 64 token overlap.
"""

import os
import json
import logging
import asyncio
import hashlib
from pathlib import Path
from datetime import datetime
from typing import Optional

import httpx
from fastapi import FastAPI
from pydantic import BaseModel
import uvicorn

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("aria-rag")

# ── Config ────────────────────────────────────────────────────────────────────

QDRANT_URL      = os.getenv("QDRANT_URL",      "http://aria-qdrant:6333")
OLLAMA_URL      = os.getenv("EMBED_OLLAMA_URL", "http://192.168.1.9:11434")
EMBED_MODEL     = os.getenv("EMBED_MODEL",      "nomic-embed-text")
KNOWLEDGE_DIR   = Path(os.getenv("KNOWLEDGE_DIR", "/app/knowledge"))
PLAYBOOKS_DIR   = Path(os.getenv("PLAYBOOKS_DIR", "/app/playbooks"))
AUDIT_DIR       = Path(os.getenv("AUDIT_DIR",     "/app/audit"))
WATCH_INTERVAL  = int(os.getenv("WATCH_INTERVAL_SECS", "60"))

COLLECTION      = "aria"
CHUNK_SIZE      = 400   # words
CHUNK_OVERLAP   = 50    # words

app = FastAPI(title="aria-rag", version="1.0.0")

# ── Chunking ──────────────────────────────────────────────────────────────────

def chunk_text(text: str, source: str) -> list[dict]:
    """
    Split text into overlapping chunks.
    Each chunk carries its source path and a content hash for deduplication.
    """
    words  = text.split()
    chunks = []
    i      = 0

    while i < len(words):
        chunk_words = words[i:i + CHUNK_SIZE]
        content     = " ".join(chunk_words)
        # Qdrant requires UUID or unsigned int — derive UUID from hash
        raw_hash    = hashlib.sha256(f"{source}:{i}:{content}".encode()).hexdigest()
        chunk_id    = f"{raw_hash[:8]}-{raw_hash[8:12]}-{raw_hash[12:16]}-{raw_hash[16:20]}-{raw_hash[20:32]}"

        chunks.append({
            "id":      chunk_id,
            "content": content,
            "source":  source,
            "offset":  i,
        })
        i += CHUNK_SIZE - CHUNK_OVERLAP

    return chunks


# ── Embedding ─────────────────────────────────────────────────────────────────

async def embed(text: str) -> Optional[list[float]]:
    """Get embedding vector from Ollama nomic-embed-text."""
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(f"{OLLAMA_URL}/api/embeddings", json={
                "model":  EMBED_MODEL,
                "prompt": text,
            })
            resp.raise_for_status()
            return resp.json().get("embedding")
    except Exception as e:
        log.warning("Embed error: %s", e)
        return None


# ── Qdrant operations ─────────────────────────────────────────────────────────

async def detect_embedding_dims() -> int:
    """Detect actual embedding dimensions from the model."""
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(f"{OLLAMA_URL}/api/embeddings", json={
                "model":  EMBED_MODEL,
                "prompt": "test",
            })
            resp.raise_for_status()
            dims = len(resp.json().get("embedding", []))
            log.info("Detected embedding dims: %d", dims)
            return dims or 768
    except Exception as e:
        log.warning("Could not detect dims, defaulting to 768: %s", e)
        return 768


async def ensure_collection():
    """Create Qdrant collection if it does not exist."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            # Check if exists
            r = await client.get(f"{QDRANT_URL}/collections/{COLLECTION}")
            if r.status_code == 200:
                # Verify dims match — delete and recreate if not
                info = r.json()
                existing_dims = info.get("result", {}).get("config", {}).get("params", {}).get("vectors", {}).get("size", 0)
                actual_dims = await detect_embedding_dims()
                if existing_dims and existing_dims != actual_dims:
                    log.warning("Dim mismatch: collection=%d model=%d — recreating", existing_dims, actual_dims)
                    await client.delete(f"{QDRANT_URL}/collections/{COLLECTION}")
                else:
                    log.info("Qdrant collection '%s' exists (%d dims)", COLLECTION, existing_dims or actual_dims)
                    return

            # Detect actual dims from model before creating collection
            dims = await detect_embedding_dims()

            r = await client.put(f"{QDRANT_URL}/collections/{COLLECTION}", json={
                "vectors": {
                    "size":     dims,
                    "distance": "Cosine",
                }
            })
            r.raise_for_status()
            log.info("Qdrant collection '%s' created with %d dims", COLLECTION, dims)
    except Exception as e:
        log.error("Qdrant collection setup failed: %s", e)


async def upsert_chunks(chunks: list[dict]):
    """Embed and upsert a batch of chunks into Qdrant."""
    points = []
    for chunk in chunks:
        vector = await embed(chunk["content"])
        if not vector:
            continue
        points.append({
            "id":      chunk["id"],
            "vector":  vector,
            "payload": {
                "content": chunk["content"],
                "source":  chunk["source"],
                "offset":  chunk["offset"],
                "ts":      datetime.utcnow().isoformat(),
            },
        })

    if not points:
        return

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.put(f"{QDRANT_URL}/collections/{COLLECTION}/points", json={
                "points": points
            })
            r.raise_for_status()
        log.info("Upserted %d chunks from %s", len(points), chunks[0]["source"])
    except Exception as e:
        log.error("Qdrant upsert failed: %s", e)


# ── Document ingestion ────────────────────────────────────────────────────────

# Track ingested file hashes to avoid re-ingesting unchanged files
_ingested: dict[str, str] = {}  # path → content hash


async def ingest_file(path: Path, source_label: str):
    """Ingest one file — skip if content unchanged."""
    try:
        content = path.read_text(encoding="utf-8", errors="ignore").strip()
        if not content:
            return

        content_hash = hashlib.sha256(content.encode()).hexdigest()[:16]
        if _ingested.get(str(path)) == content_hash:
            return  # unchanged — skip

        chunks = chunk_text(content, source_label)
        await upsert_chunks(chunks)
        _ingested[str(path)] = content_hash

    except Exception as e:
        log.warning("Ingest error %s: %s", path, e)


async def ingest_all():
    """Ingest all knowledge sources."""
    log.info("Ingestion cycle starting")

    # Standards and skills
    for md_file in KNOWLEDGE_DIR.rglob("*.md"):
        label = f"knowledge/{md_file.relative_to(KNOWLEDGE_DIR)}"
        await ingest_file(md_file, label)

    # Playbooks
    if PLAYBOOKS_DIR.exists():
        for pb_file in PLAYBOOKS_DIR.glob("*.yaml"):
            label = f"playbook/{pb_file.stem}"
            await ingest_file(pb_file, label)

    # ACiDF files — user profiles built from discovery history
    # Each file is scoped by its ACiD (UCiD:UUiD) filename
    if AUDIT_DIR.exists():
        for audit_file in AUDIT_DIR.glob("*.jsonl"):
            label = f"acidf/{audit_file.stem}"
            await ingest_file(audit_file, label)

    log.info("Ingestion cycle complete")


async def ingest_loop():
    """Ingest at startup then watch for changes every WATCH_INTERVAL seconds."""
    await ensure_collection()
    while True:
        try:
            await ingest_all()
        except Exception as e:
            log.error("Ingest loop error: %s", e)
        await asyncio.sleep(WATCH_INTERVAL)


# ── Search endpoint ───────────────────────────────────────────────────────────

class SearchRequest(BaseModel):
    query:   str
    cid:     Optional[str] = None   # scopes ACiDF results to this user
    top_k:   int = 3
    sources: Optional[list[str]] = None  # filter by source prefix e.g. ["playbook/", "knowledge/standards/"]


class SearchResult(BaseModel):
    content: str
    source:  str
    score:   float


@app.post("/search", response_model=list[SearchResult])
async def search(req: SearchRequest):
    """
    Search Qdrant for chunks relevant to query.
    Called by ruflo orchestrator when LLM needs context.
    cid used to include user's ACiDF in results.
    """
    vector = await embed(req.query)
    if not vector:
        return []

    # Build filter — scope ACiDF to this user's CiD if provided
    must_conditions = []
    if req.sources:
        # Filter to specific source prefixes
        must_conditions.append({
            "should": [
                {"key": "source", "match": {"text": s}}
                for s in req.sources
            ]
        })

    payload_filter = {"must": must_conditions} if must_conditions else None

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            body: dict = {
                "vector":      vector,
                "limit":       req.top_k,
                "with_payload": True,
            }
            if payload_filter:
                body["filter"] = payload_filter

            r = await client.post(
                f"{QDRANT_URL}/collections/{COLLECTION}/points/search",
                json=body,
            )
            r.raise_for_status()
            results = r.json().get("result", [])

    except Exception as e:
        log.error("Qdrant search error: %s", e)
        return []

    # If cid provided — also search user's ACiDF specifically
    # Merge with general results, deduplicate
    if req.cid:
        acid = _cid_to_acid_prefix(req.cid)
        if acid:
            try:
                async with httpx.AsyncClient(timeout=10) as client:
                    r = await client.post(
                        f"{QDRANT_URL}/collections/{COLLECTION}/points/search",
                        json={
                            "vector": vector,
                            "limit":  2,
                            "with_payload": True,
                            "filter": {
                                "must": [{
                                    "key":   "source",
                                    "match": {"text": f"acidf/{acid}"}
                                }]
                            },
                        },
                    )
                    r.raise_for_status()
                    user_results = r.json().get("result", [])
                    # Prepend user results — user context is highest priority
                    results = user_results + results
            except Exception:
                pass  # user ACiDF not yet available — proceed without it

    # Deduplicate by point id, keep top_k
    seen = set()
    final = []
    for r in results:
        pid = r.get("id")
        if pid not in seen:
            seen.add(pid)
            final.append(SearchResult(
                content=r["payload"]["content"],
                source=r["payload"]["source"],
                score=r.get("score", 0.0),
            ))
        if len(final) >= req.top_k:
            break

    return final


def _cid_to_acid_prefix(cid: str) -> str:
    """Extract ACiD prefix (UCiD:UUiD) from full CiD for ACiDF scoping."""
    parts = cid.split(":")
    if len(parts) >= 2:
        return f"{parts[0]}:{parts[1]}"
    return ""


@app.get("/health")
async def health():
    return {"status": "ok", "service": "aria-rag", "ts": datetime.utcnow().isoformat()}


# ── Main ──────────────────────────────────────────────────────────────────────

@app.on_event("startup")
async def startup():
    asyncio.create_task(ingest_loop())


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8300, log_level="info")
