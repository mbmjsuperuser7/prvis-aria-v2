# prvis-aria-v2

Aria v2 — security AI assistant platform.

## Architecture

```
web (Next.js)          — frontend, CiD assembly, Kafka producer, Redis SSE
aria-orchestrator-v2   — ruflo Thompson bandit, routes to α/γ/β Ollamas
aria-rag               — RAG ingestion + search (LLM calls as tool)
aria-qdrant            — vector store
aria-ccf               — KV cache warm (name prompts + tool registry)
aria-audit             — Presidio anonymization, ACiDF audit trail
aria-sandbox           — execution sandbox
Kafka, Redis, Presidio, Guacamole — infrastructure
```

## LLM instances

| Symbol | Model | Hardware | Server |
|---|---|---|---|
| α | qwen3:30b-a3b | GPU | alpha-ai (192.168.1.9) |
| γ | qwen3:14b | GPU | vikas-Alien (100.66.170.90) |
| β | qwen3:8b | CPU | alpha-ai (192.168.1.9) |

## Deploy

```bash
cp .env.example .env
# Edit .env as needed
docker compose up -d
```

## Prerequisites
- Ollama running on alpha-ai and vikas-Alien with models pulled
- `ollama pull nomic-embed-text` on alpha-ai
