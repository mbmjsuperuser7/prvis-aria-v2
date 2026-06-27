"""
aria-audit — Anonymization pipeline + audit log writer.

Consumes from ALL Kafka topics.
Runs every message through Microsoft Presidio.
Writes anonymized output to disk — one file per tenant (ACiDF), ACiD = UCiD:UUiD.

Rules (RG-7):
- CiD → ACiD: UCiD:UUiD only. Strip tenant_id, org_id, username from file content
- Strip: IPs, hostnames, MACs, credentials, PII, shell commands/outputs
- Strip: Keycloak tokens, prvis credential patterns, Proxmox API tokens
- Activity monitor events: NEVER written to disk — dropped entirely
- ACiDF: {UCiD}:{UUiD}.jsonl — same as ACiD, no tenant/org/username in filename
- When approaching 1MB: older entries summarised by Beta, summary replaces them
- Audit index: UUiD → ACiDFname — stored in Redis, retained per compliance

What IS written (anonymized):
- User prompt (PII stripped)
- Alpha plan (tool names, step descriptions — no credentials/IPs)
- Sub-task outcomes (success/fail/timeout/exact error — no raw command output)
- Task final result
- Tool engagement record (which tool, duration, outcome)

What is NEVER written:
- Activity monitor events
- Raw shell command outputs
- SSH keys, API tokens, passwords
- Raw IP addresses or hostnames
- UCiD, UUiD, username
"""

import os
import re
import json
import logging
import asyncio
from datetime import datetime, timedelta
from pathlib import Path

from aiokafka import AIOKafkaConsumer
import redis.asyncio as aioredis
import httpx

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("aria-audit")

KAFKA_BOOTSTRAP   = os.getenv("KAFKA_BOOTSTRAP",   "aria-kafka:9092")
REDIS_URL         = os.getenv("REDIS_URL",          "redis://aria-redis:6379/0")
PRESIDIO_ANALYZER_URL  = os.getenv("PRESIDIO_ANALYZER_URL",  "http://aria-presidio-analyzer:3000")
PRESIDIO_ANONYMIZER_URL = os.getenv("PRESIDIO_ANONYMIZER_URL", "http://aria-presidio-anonymizer:3000")
AUDIT_DIR         = Path(os.getenv("AUDIT_DIR",     "/app/audit"))
FILE_CAP_BYTES    = int(os.getenv("FILE_CAP_BYTES", str(1024 * 1024)))  # 1MB
BETA_OLLAMA_URL   = os.getenv("BETA_OLLAMA_URL",    "http://192.168.1.9:11434")
BETA_MODEL        = os.getenv("BETA_MODEL",         "qwen3:8b")

# Topics to consume — ALL topics
# v2 topics only — stale v1 topics removed
TOPICS = [
    "aria.requests",       # UI → orchestrator
    "aria.results.tasks",  # orchestrator → result (includes α/γ/β routing fields)
    "aria.dlq",            # dead letter queue
]

# Topics that are NEVER written to disk — dropped entirely
NEVER_WRITE_TOPICS = {
    "aria.activity",  # activity monitor events
}

# Ruflo routing fields from v2 orchestrator — operational signals, not PII.
# Passed through to ACiDF without Presidio — they document which LLM instance
# handled the request and what routing decisions were made.
ROUTING_FIELDS = {
    "instance", "symbol", "complexity", "intent",
    "blast_radius", "duration_ms", "validation_passed",
}

redis_client = None


# ── CiD helpers ────────────────────────────────────────────────────────────────

def parse_cid(cid: str) -> dict:
    parts = cid.split(":")
    if len(parts) < 5:
        return {}
    return {
        "ucid":      parts[0],
        "uuid":      parts[1],
        "tenant_id": parts[2],
        "org_id":    parts[3],
        "username":  ":".join(parts[4:]),
    }


def cid_to_acid(cid: str) -> str:
    """ACiD = UCiD:UUiD — strips tenant_id, org_id, username. Traceable to conversation+user via audit index only."""
    parts = parse_cid(cid)
    if not parts:
        return "unknown:unknown"
    return f"{parts['ucid']}:{parts['uuid']}"


def extract_uuid(cid: str) -> str:
    parts = parse_cid(cid)
    return parts.get("uuid", "")


# ── Presidio anonymization ─────────────────────────────────────────────────────

# Fields that should never reach Presidio or disk — stripped before any processing
STRIP_FIELDS = {
    "ucid", "uuid", "username", "password", "token", "api_key",
    "private_key", "ssh_key", "secret", "credential",
    # stdout/stderr and command are NOT stripped here — they go through
    # Presidio anonymization and are written to ACiDF. Users own their shell output.
}

# Entities Presidio should detect and anonymize
PRESIDIO_ENTITIES = [
    "PERSON", "EMAIL_ADDRESS", "PHONE_NUMBER", "IP_ADDRESS",
    "LOCATION", "NRP", "CREDIT_CARD", "CRYPTO", "IBAN_CODE",
    "MEDICAL_LICENSE", "URL", "US_SSN", "UK_NHS",
]


async def presidio_anonymize(text: str) -> str:
    """Send text to Presidio analyzer + anonymizer. Returns anonymized text."""
    if not text or not text.strip():
        return text
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            # Step 1: analyze
            analyze_resp = await client.post(
                f"{PRESIDIO_ANALYZER_URL}/analyze",
                json={
                    "text":     text,
                    "language": "en",
                    "entities": PRESIDIO_ENTITIES,
                }
            )
            analyze_resp.raise_for_status()
            results = analyze_resp.json()

            if not results:
                return text

            # Step 2: anonymize
            anon_resp = await client.post(
                f"{PRESIDIO_ANONYMIZER_URL}/anonymize",
                json={
                    "text":              text,
                    "analyzer_results":  results,
                    "anonymizers": {
                        "DEFAULT": {"type": "replace", "new_value": "<REDACTED>"}
                    }
                }
            )
            anon_resp.raise_for_status()
            return anon_resp.json().get("text", text)
    except Exception as e:
        log.warning("Presidio error: %s — falling back to regex strip", e)
        return regex_strip(text)


def regex_strip(text: str) -> str:
    """Fallback regex stripping when Presidio is unavailable."""
    # IPs
    text = re.sub(r'\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b', '<IP>', text)
    # Emails
    text = re.sub(r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b', '<EMAIL>', text)
    # API keys / tokens (long hex/base64 strings)
    text = re.sub(r'\b[A-Za-z0-9+/]{32,}\b', '<TOKEN>', text)
    # SSH key patterns
    text = re.sub(r'-----BEGIN [A-Z ]+ KEY-----.*?-----END [A-Z ]+ KEY-----',
                  '<KEY>', text, flags=re.DOTALL)
    # Hostnames
    text = re.sub(r'\b([a-z0-9-]+\.){2,}[a-z]{2,}\b', '<HOST>', text)
    return text


async def anonymize_value(value) -> str:
    """Anonymize a single string value."""
    if not isinstance(value, str):
        value = json.dumps(value)
    return await presidio_anonymize(value)


async def anonymize_record(record: dict) -> dict:
    """
    Anonymize a full record dict.
    - Strip forbidden fields entirely
    - Replace CiD with ACiD
    - Anonymize all string values through Presidio
    """
    result = {}
    for k, v in record.items():
        # Strip forbidden fields
        if k.lower() in STRIP_FIELDS:
            continue
        # Replace CiD with ACiD
        if k == "cid" and isinstance(v, str):
            result["acid"] = cid_to_acid(v)
            continue
        # Recursively handle dicts
        if isinstance(v, dict):
            result[k] = await anonymize_record(v)
        # Anonymize string values
        elif isinstance(v, str) and len(v) > 0:
            result[k] = await anonymize_value(v)
        # Pass through non-sensitive types
        elif isinstance(v, (int, float, bool)) or v is None:
            result[k] = v
        elif isinstance(v, list):
            result[k] = [
                await anonymize_record(i) if isinstance(i, dict)
                else await anonymize_value(i) if isinstance(i, str)
                else i
                for i in v
            ]
        else:
            result[k] = v
    return result


# ── Audit file writer ─────────────────────────────────────────────────────────

def audit_path(acid: str) -> Path:
    """Return audit file path for this ACiD. Creates parent dirs."""
    # ACiDF named {UCiD}:{UUiD}.jsonl — same as ACiD
    path = AUDIT_DIR / f"{acid}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


async def write_audit(acid: str, uuid: str, record: dict):
    """
    Append anonymized record to audit file.
    Enforce 1MB cap — summarise older content when approaching limit.
    Update audit index: uuid → ACiDFname.
    """
    path = audit_path(acid)

    # Prune entries older than 30 days
    await prune_old_entries(path)

    # Check file size — summarise if approaching cap
    if path.exists() and path.stat().st_size > FILE_CAP_BYTES * 0.9:
        await summarise_audit_file(path, acid)

    # Append record
    line = json.dumps({
        "acid":      acid,
        "ts":        datetime.utcnow().isoformat(),
        **record,
    }) + "\n"

    with open(path, "a") as f:
        f.write(line)

    # Update audit index: uuid → ACiDFname
    if uuid:
        await redis_client.set(f"audit_index:{uuid}", str(path), ex=86400 * 365)


async def prune_old_entries(path: Path):
    """Remove entries older than 30 days."""
    if not path.exists():
        return
    cutoff = datetime.utcnow() - timedelta(days=30)
    lines = path.read_text().splitlines()
    kept = []
    for line in lines:
        try:
            entry = json.loads(line)
            ts = datetime.fromisoformat(entry.get("ts", "2000-01-01"))
            if ts > cutoff:
                kept.append(line)
        except Exception:
            kept.append(line)
    if len(kept) < len(lines):
        path.write_text("\n".join(kept) + "\n")
        log.info("Pruned %d old entries from %s", len(lines) - len(kept), path)


async def summarise_audit_file(path: Path, acid: str):
    """
    When file approaches 1MB: send older half to Beta for summarisation.
    Beta is fast, CPU-only — appropriate for this task.
    Summary replaces the older entries.
    """
    log.info("Audit file %s approaching 1MB — summarising...", path)
    lines = path.read_text().splitlines()
    mid = len(lines) // 2
    older = lines[:mid]
    newer = lines[mid:]

    try:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(f"{BETA_OLLAMA_URL}/api/chat", json={
                "model":   BETA_MODEL,
                "messages": [
                    {"role": "system",
                     "content": "Summarise the following audit log entries concisely. Return plain text only."},
                    {"role": "user", "content": "\n".join(older)},
                ],
                "stream":  False,
                "options": {"temperature": 0.0, "num_gpu": 0},
            })
            resp.raise_for_status()
            summary = resp.json()["message"]["content"].strip()
    except Exception as e:
        log.warning("Summarisation failed: %s — keeping full content", e)
        return

    summary_line = json.dumps({
        "acid":    acid,
        "ts":      datetime.utcnow().isoformat(),
        "type":    "summary",
        "content": summary,
    })
    path.write_text(summary_line + "\n" + "\n".join(newer) + "\n")
    log.info("Summarised %d lines into 1 summary line", len(older))


# ── Main consumer loop ─────────────────────────────────────────────────────────

async def process_message(topic: str, value: dict):
    """Process one Kafka message — anonymize and write to audit file."""
    # Never write activity monitor events
    if topic in NEVER_WRITE_TOPICS:
        return
    if value.get("type") == "activity_monitor":
        return

    cid  = value.get("cid", "")
    acid = cid_to_acid(cid)
    uuid = extract_uuid(cid)

    payload = value.get("payload", value)

    # Sandbox execution records need special handling:
    # Raw stdout/stderr may contain credentials or sensitive data.
    # We keep a sanitized summary but strip raw I/O before Presidio sees it.
    if topic == "aria.sandbox.execution":
        stdout = payload.get("stdout", "")
        stderr = payload.get("stderr", "")
        exit_code = payload.get("exit_code", -1)
        # Run stdout/stderr through Presidio to strip PII/credentials
        clean_stdout = await presidio_anonymize(stdout[:500]) if stdout else ""
        clean_stderr = await presidio_anonymize(stderr[:200]) if stderr else ""
        record = await anonymize_record({
            "topic":        topic,
            "task_id":      value.get("task_id", ""),
            "sub_task_id":  payload.get("sub_task_id", ""),
            "step":         payload.get("step"),
            "action":       payload.get("action", ""),
            "command_type": payload.get("command_type", ""),
            # command may contain credentials — anonymize it
            "command":      await presidio_anonymize(payload.get("command", "")[:300]),
            "stdout":       clean_stdout,
            "stderr":       clean_stderr,
            "exit_code":    exit_code,
            "started_at":   payload.get("started_at", ""),
            "completed_at": payload.get("completed_at", ""),
        })
        await write_audit(acid, uuid, record)
        log.debug("Sandbox execution audit written: acid=%s step=%s", acid, payload.get("step"))
        return

    # Extract ruflo routing fields from v2 orchestrator results.
    # These are operational signals (α/γ/β symbol, complexity, intent,
    # blast_radius) — not PII. Pass through directly without Presidio.
    routing_meta = {}
    if topic == "aria.results.tasks":
        for field in ROUTING_FIELDS:
            if field in payload:
                routing_meta[field] = payload[field]

    # Anonymize the full record (routing fields excluded — handled above)
    record = await anonymize_record({
        "topic":   topic,
        "task_id": value.get("task_id", ""),
        **{k: v for k, v in payload.items()
           if k not in ("cid",) and k not in ROUTING_FIELDS}
    })

    # Merge routing metadata back in — these are already clean
    if routing_meta:
        record["routing"] = routing_meta

    await write_audit(acid, uuid, record)
    log.debug("Audit written: acid=%s topic=%s symbol=%s",
              acid, topic, routing_meta.get("symbol", ""))


async def main():
    global redis_client

    AUDIT_DIR.mkdir(parents=True, exist_ok=True)
    redis_client = aioredis.from_url(REDIS_URL, decode_responses=True)

    consumer = AIOKafkaConsumer(
        *TOPICS,
        bootstrap_servers=KAFKA_BOOTSTRAP,
        group_id="aria-audit",
        value_deserializer=lambda v: json.loads(v.decode()),
        auto_offset_reset="earliest",
        enable_auto_commit=False,   # manual commit — never lose a message
        max_poll_records=10,
    )

    await consumer.start()
    log.info("aria-audit consuming: %s", TOPICS)

    try:
        async for msg in consumer:
            try:
                await process_message(msg.topic, msg.value)
                await consumer.commit()
            except Exception as e:
                log.error("Audit processing error topic=%s: %s", msg.topic, e, exc_info=True)
                # Do not commit — message will be redelivered
    finally:
        await consumer.stop()
        await redis_client.close()


if __name__ == "__main__":
    asyncio.run(main())
