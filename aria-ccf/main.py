"""
aria-ccf — session tracking and tool registry service.

Responsibilities:
1. On first message in a session — write user first name to Redis
   key ccf:session:{cid} so the orchestrator prepends it to the first message only.

2. Write tool registry to Redis so the orchestrator knows what tools
   are available to expose to the LLMs.

System prompt / identity is baked into Ollama modelfiles (aria-alpha, aria-beta,
aria-gamma) — not managed here. No KV cache warming needed.
"""

import os
import json
import logging
import asyncio

from aiokafka import AIOKafkaConsumer
import redis.asyncio as aioredis

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("aria-ccf")

KAFKA_BOOTSTRAP = os.getenv("KAFKA_BOOTSTRAP", "aria-kafka:9092")
REDIS_URL       = os.getenv("REDIS_URL",        "redis://aria-redis:6379/0")
TOPIC_REQUESTS  = "aria.requests"
SESSION_TTL     = 86400  # 24h
TOOL_TTL        = 86400 * 7

redis_client = None

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
    await redis_client.set("ccf:tools", json.dumps(TOOL_REGISTRY), ex=TOOL_TTL)
    log.info("Tool registry written to Redis")


async def handle_request(msg: dict):
    """On first message in a session — write first name to Redis."""
    cid     = msg.get("cid", "")
    payload = msg.get("payload", {})

    session_key = f"ccf:session:{cid}"
    if await redis_client.exists(session_key):
        return

    username   = payload.get("username", "") or ""
    first_name = username.split("@")[0].split(".")[0]
    first_name = first_name.capitalize() if first_name else ""

    if first_name and first_name.lower() != "default-user":
        await redis_client.set(session_key, first_name, ex=SESSION_TTL)
        log.info("Session first name set: cid=%s name=%s", cid[:20], first_name)


async def main():
    global redis_client

    redis_client = aioredis.from_url(REDIS_URL, decode_responses=True)
    log.info("aria-ccf starting")

    await write_tool_registry()

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
