# Aria — Goals, Design Decisions, and Transcript Summary
**Last updated:** 2026-06-27  
**Status:** Living document — built incrementally from conversation transcript

---

## Raw Goals (from transcript, verbatim intent)

- Build a multi-brain AI agent that can independently perform tasks required to meet compliance (GDPR, ISO, SOC2, NIS2, IEC 62443, NIST CSF, ITIL)
- CC (Claude Code) as the brain — ruflo provides the nervous system
- Ruflo as orchestrator — not Python for everything
- 3 second response for conversational, activity visible within 2 seconds for complex
- User never stares at blank screen — every node touch, tool call, routing decision visible in activity pane
- Message delivery guaranteed — delivered or error, never silence (WhatsApp/Telegram model)
- Prompt to LLM = user message only. First message gets first name prepended. Nothing else.
- No pre-fetching context, no padding, no injecting history
- Everything the LLM needs — permissions, knowledge, playbooks, standards — in RAG, searched by LLM when needed
- RAG is a tool the LLM calls. Not pre-fed. Not pre-packaged.
- LLM identity baked into Ollama modelfile. Not injected per request.
- ACiDF = audit trail + user profile. Same file. Two jobs.
- User profile builds through discovery over time. Not from IdP upfront.
- Too many containers doing too little — collapse to minimum
- UI must be enterprise-grade, server-side only. No browser-side business logic.
- Kafka for message persistence and burst absorption. Redis pub/sub for live activity feed.
- Signal capture (IP, UA, fingerprint, etc) server-side only. Never reaches LLM. Audit only.
- CiD assembled server-side. LLM never sees it.
- Kong removed — auth already done by Keycloak upstream
- β only for conversational. Actionable tasks go to γ or α.
- Blast radius classification before any LLM call — destructive ops require user confirmation
- Prompt injection is the only thing blocked at UI. Everything else reaches the LLM.
- Fine-tuning is future work. Modelfiles are interim identity solution.
- NIST CSF and IEC 62443 to be added to RAG knowledge base.

---

## What Was Built

### Containers Running

| Container | What it does |
|---|---|
| aria-web (Next.js) | Frontend — server-side only. Signal capture, CiD assembly, Kafka producer, Redis pub/sub SSE to browser |
| aria-orchestrator (ruflo Node.js) | Thompson bandit router, routes to α/γ/β, tool execution, blast radius classification, activity pane feed |
| aria-rag | Ingests knowledge into Qdrant, serves search endpoint. LLM calls knowledge_search as tool |
| aria-qdrant | Vector store — standards, playbooks, tools, ACiDF |
| aria-ccf | Session first-name tracking, tool registry write to Redis |
| aria-audit | Presidio anonymization, ACiDF write to disk. Off request path entirely |
| aria-sandbox | Execution sandbox |
| Kafka, Redis, Presidio, Guacamole | Infrastructure |

### What Was Deleted

- aria-alpha, aria-beta, aria-gamma — Python LLM containers
- aria-orchestrator (old Python) — replaced by ruflo Node.js
- aria-intake — merged into Next.js
- Kong — removed, Keycloak handles auth upstream
- ccf-init — redundant, CCF baked into aria-ccf image
- ccf-data volume — no longer used
- All verbose CCF loading, playbook injection from prompts
- History injection from prompts
- Tool definitions from per-request Ollama API calls
- All content-based forbidden patterns except prompt injection

### LLM Instances

| Symbol | Model | Ollama server | Hardware | When used |
|---|---|---|---|---|
| α | aria-alpha (FROM qwen3:30b-a3b) | alpha-ai 192.168.1.9 | GPU | Actionable high complexity |
| γ | aria-gamma (FROM qwen3:14b) | Alienware 100.66.170.90 (Tailscale) | GPU | Actionable low-medium complexity |
| β | aria-beta (FROM qwen3:8b) | alpha-ai 192.168.1.9 | CPU | Conversational only |

---

## Routing Logic

Thompson bandit in pure JS — sub-millisecond, no LLM call.

**Intent classification (fires first):**
- Conversational → β only (pure greetings, no action words)
- Actionable → γ or α (anything with action words: run, create, scan, deploy, configure etc)

**Complexity scoring (determines γ vs α for actionable):**
- Low-medium actionable → γ
- High complexity actionable → α

**Blast radius (fires before LLM call):**
- High (delete, destroy, wipe, terminate, revoke) → user confirmation required before execution
- Everything else → proceeds

**β score = 0 for any actionable message.**

---

## Prompt Contract

**What the LLM receives:**

First message in session:
```
[FirstName]: [user message]
```

Every subsequent message:
```
[user message]
```

**What the LLM never receives:**
- CiD, UUID, session metadata
- Signal capture data (IP, UA, fingerprint, etc)
- Pre-fetched RAG context
- Conversation history
- Tool definitions per request
- System prompt per request (identity in modelfile)

**Identity:** Baked into Ollama modelfile SYSTEM prompt. Not injected per request.

**Tools:** LLM knows about knowledge_search from modelfile. Calls it when needed. Orchestrator executes the call and returns result.

---

## Data Flow

```
Browser (HTML only)
  ↕ HTTP
Next.js (frontend container)
  — signal capture server-side
  — CiD assembly
  — prompt injection check (prompt injection only)
  — Kafka produce → aria.requests
  — Redis pub/sub subscribe → SSE to browser
  ↕ Kafka
aria-orchestrator (ruflo)
  — intent + blast radius classification
  — Thompson bandit routes to α/γ/β
  — calls Ollama directly
  — LLM calls knowledge_search tool if needed → aria-rag → Qdrant
  — writes activity to Redis pub/sub (browser sees it instantly)
  — writes result to Redis + Kafka
  ↕ Kafka (all topics)
aria-audit
  — Presidio anonymization
  — writes ACiDF to disk
```

---

## RAG Knowledge Base

Stored in Qdrant. LLM searches when needed via knowledge_search tool.

**Currently ingested:**
- ISO 27001
- NIS2
- SOC2
- ITIL (change, incident, problem management)
- Tool registry
- Change management playbook
- Incident response playbook
- Vulnerability management playbook

**Pending:**
- NIST CSF
- IEC 62443
- ACiDF user profiles (ingested as they're written by aria-audit)

---

## ACiDF

Two jobs, one file:

1. **Compliance audit trail** — anonymized by Presidio, retained per regulatory requirement
2. **User knowledge base** — LLM searches via RAG to understand user permissions and history

**What gets written:**
- Anonymized conversation content
- α/γ/β symbol (which instance handled it)
- Task outcomes per step
- Access events: what, how, outcome
- CiD reduced to ACiD (UCiD:UUiD only)

**What never gets written:**
- Raw credentials or secrets
- Activity monitor events
- Tool outputs with sensitive data

---

## Open Items

1. **Names for α, γ, β** — TBD
2. **Fine-tuning pipeline** — future work, hardware and frequency TBD
3. **NIST CSF + IEC 62443** — add to aria-rag/knowledge/standards/
4. **Kafka delete API** — user-initiated conversation deletion
5. **Tailscale on prvis-ai** — needed for γ calls to Alienware (100.66.170.90)
6. **aria-gamma modelfile** — needs to be created on Alienware
7. **nomic-embed-text** — confirm pulled on alpha-ai for RAG embeddings
8. **ACiDF → RAG ingestion** — confirm pipeline working end to end

---

## Decisions Made (with reasoning)

**Ruflo as orchestrator, not Python** — Python was 5 separate containers doing too little. Ruflo is one Node.js process with routing, tool execution, and activity feed built in.

**Redis pub/sub for activity, Kafka for persistence** — Kafka is durable message queue between services. Redis pub/sub is lightweight push for live browser feed. Different jobs, right tools.

**No history in prompts** — LLM is stateless by design. History injection is padding. Context window is the agreed mechanism.

**Modelfile for identity, not per-request system prompt** — System prompt per request adds tokens every call. Modelfile bakes identity in once. Zero cost per request.

**RAG as LLM tool, not pre-fetched** — Orchestrator can't know what the LLM needs. LLM calls knowledge_search when it needs something. Orchestrator executes and returns result.

**β = conversational only** — β (qwen3:8b) is fast and cheap but not suited for actionable security tasks. Router gives β score=0 for anything actionable.

**Prompt injection only blocked at UI** — All other content (network scan, SSH, etc) is legitimate security work. LLM decides how to respond.
