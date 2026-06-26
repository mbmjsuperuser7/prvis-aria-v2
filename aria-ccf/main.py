"""
aria-ccf — KV cache warm service. Simplified for v2 architecture.

Responsibilities:
1. Load name-only prompt files (alpha.md / gamma.md / beta.md) into
   Ollama KV cache at startup and every 4 hours.
   Writes each prompt to Redis key ccf:system:{instance} so the
   orchestrator can retrieve it per-request without disk reads.

2. On first message in a session — write user first name to Redis key
   ccf:session:{cid} so the orchestrator can build the first-message
   prompt: "[FirstName]: [message]"

Prompt contract (agreed):
  First message:      [user first name] + [user message]
  Subsequent:         [user message]
  System prompt:      name only — "Your name is α." etc.
  Everything else:    fine-tuned weights or RAG

KV cache mechanics:
  POST /api/chat with system prompt + keep_alive=-1
  Ollama caches KV state for that exact system prefix
  Every subsequent request with identical system hits cache — zero recompute cost
"""

import os
import json
import logging
import asyncio
from datetime import datetime
from pathlib import Path

import httpx
from aiokafka import AIOKafkaConsumer
import redis.asyncio as aioredis

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("aria-ccf")

KAFKA_BOOTSTRAP  = os.getenv("KAFKA_BOOTSTRAP",  "aria-kafka:9092")
REDIS_URL        = os.getenv("REDIS_URL",         "redis://aria-redis:6379/0")
CCF_DIR          = Path(os.getenv("CCF_DIR",      "/app/ccf"))
CCF_REFRESH_SECS = int(os.getenv("CCF_REFRESH_SECONDS", "14400"))  # 4 hours

ALPHA_URL   = os.getenv("ALPHA_OLLAMA_URL", "http://192.168.1.9:11434")
ALPHA_MODEL = os.getenv("ALPHA_MODEL",      "qwen3:30b-a3b")
GAMMA_URL   = os.getenv("GAMMA_OLLAMA_URL", "http://192.168.1.9:11434")
GAMMA_MODEL = os.getenv("GAMMA_MODEL",      "qwen3:14b")
BETA_URL    = os.getenv("BETA_OLLAMA_URL",  "http://192.168.1.9:11434")
BETA_MODEL  = os.getenv("BETA_MODEL",       "qwen3:8b")

TOPIC_REQUESTS = "aria.requests"
SESSION_TTL    = 86400  # 24h

redis_client = None

# ── Instances config ──────────────────────────────────────────────────────────

INSTANCES = {
    "alpha": {
        "url":      ALPHA_URL,
        "model":    ALPHA_MODEL,
        "ccf_file": "alpha-security.md",  # contains: "Your name is α."
    },
    "gamma": {
        "url":      GAMMA_URL,
        "model":    GAMMA_MODEL,
        "ccf_file": "gamma.md",           # contains: "Your name is γ."
    },
    "beta": {
        "url":      BETA_URL,
        "model":    BETA_MODEL,
        "ccf_file": "beta.md",            # contains: "Your name is β."
    },
}

# ── KV cache warm ─────────────────────────────────────────────────────────────

async def warm_instance(name: str, cfg: dict, prompt: str) -> bool:
    """
    Load prompt into Ollama KV cache.
    keep_alive=-1 keeps the KV state resident in VRAM indefinitely.
    Subsequent requests with identical system prompt hit cache — zero recompute.
    """
    try:
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(f"{cfg['url']}/api/chat", json={
                "model":      cfg["model"],
                "messages":   [
                    {"role": "system", "content": prompt},
                    {"role": "user",   "content": "Ready."},
                ],
                "stream":     False,
                "keep_alive": -1,
                "options":    {"temperature": 0.0},
            })
            resp.raise_for_status()
        log.info("KV warm OK: %s (%s)", name, cfg["model"])
        return True
    except httpx.TimeoutException:
        log.warning("KV warm timeout: %s", name)
        return False
    except Exception as e:
        log.warning("KV warm failed: %s — %s", name, e)
        return False


async def warm_all():
    """Warm all three instances and write prompts to Redis."""
    log.info("KV cache warm cycle starting")

    for name, cfg in INSTANCES.items():
        ccf_path = CCF_DIR / cfg["ccf_file"]
        if not ccf_path.exists():
            log.warning("CCF file missing: %s", ccf_path)
            continue

        prompt = ccf_path.read_text().strip()
        if not prompt:
            log.warning("CCF file empty: %s", ccf_path)
            continue

        # Write to Redis — orchestrator reads this per-request
        await redis_client.set(
            f"ccf:system:{name}",
            prompt,
            ex=CCF_REFRESH_SECS + 3600,
        )

        # Warm Ollama KV cache
        await warm_instance(name, cfg, prompt)

    await write_tool_registry()
    log.info("KV cache warm cycle complete")


TOOL_REGISTRY = {
    "knowledge_search": {
        "description": "Search the knowledge base — standards, playbooks, tool registry, user history",
        "parameters": {
            "query":   {"type": "string",  "required": True,  "description": "What to search for"},
            "sources": {"type": "array",   "required": False, "description": "Filter by source prefix"},
            "top_k":   {"type": "integer", "required": False, "description": "Number of results (default 3)"},
        },
    },
}


async def write_tool_registry():
    """Write tool definitions to Redis — orchestrator loads these per session."""
    await redis_client.set(
        "ccf:tools",
        json.dumps(TOOL_REGISTRY),
        ex=CCF_REFRESH_SECS + 3600,
    )
    log.info("Tool registry written to Redis")


async def warm_loop():
    """Warm at startup then every 4 hours."""
    await asyncio.sleep(5)  # let models load first
    while True:
        try:
            await warm_all()
        except Exception as e:
            log.error("Warm loop error: %s", e)
        await asyncio.sleep(CCF_REFRESH_SECS)


# ── Session first-name tracking ───────────────────────────────────────────────

async def handle_request(msg: dict):
    """
    On first message in a session — extract first name from username,
    write to Redis so the orchestrator uses it on the first prompt only.
    """
    cid     = msg.get("cid", "")
    payload = msg.get("payload", {})

    # Only set on new sessions — if key exists, session already started
    session_key = f"ccf:session:{cid}"
    if await redis_client.exists(session_key):
        return

    username   = payload.get("username", "") or ""
    first_name = username.split("@")[0].split(".")[0]
    first_name = first_name.capitalize() if first_name else ""

    if first_name:
        await redis_client.set(session_key, first_name, ex=SESSION_TTL)
        log.debug("Session first name set: cid=%s name=%s", cid[:20], first_name)


# ── Main ──────────────────────────────────────────────────────────────────────

async def main():
    global redis_client

    redis_client = aioredis.from_url(REDIS_URL, decode_responses=True)
    log.info("aria-ccf starting")

    asyncio.create_task(warm_loop())

    consumer = AIOKafkaConsumer(
        TOPIC_REQUESTS,
        bootstrap_servers=KAFKA_BOOTSTRAP,
        group_id="aria-ccf",
        value_deserializer=lambda v: json.loads(v.decode()),
        auto_offset_reset="latest",
        enable_auto_commit=True,
    )
    await consumer.start()
    log.info("aria-ccf consuming %s", TOPIC_REQUESTS)

    try:
        async for msg in consumer:
            try:
                await handle_request(msg.value)
            except Exception as e:
                log.error("Session handler error: %s", e)
    finally:
        await consumer.stop()
        await redis_client.close()


if __name__ == "__main__":
    asyncio.run(main())
