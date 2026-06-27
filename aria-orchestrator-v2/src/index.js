/**
 * aria-orchestrator v2 — ruflo-powered, replaces aria-alpha/beta/gamma/orchestrator.
 *
 * Consumes: aria.requests
 * Produces: aria.results.tasks, aria.dlq
 * Writes:   Redis activity:{cid}, result:{task_id}, history:{cid}
 *
 * Flow per message:
 *   1. Classify intent + blast radius (pure JS, sub-ms)
 *   2. Score complexity (pure JS, sub-ms)
 *   3. Thompson bandit picks instance (α/γ/β)
 *   4. Write routing decision to activity pane immediately
 *   5. If high blast radius → write confirmation-required to activity, wait
 *      (confirmation comes as a follow-up message on same CiD)
 *   6. Load system prompt (name) from Redis KV cache
 *   7. Load conversation history from Redis
 *   8. Call selected Ollama instance
 *   9. For actionable high-complexity responses — invoke validation pass
 *  10. Write result to Redis + Kafka
 *  11. Record outcome back to bandit
 *
 * Kafka topics kept identical to v1 for zero-disruption migration.
 */

import { Kafka, logLevel } from 'kafkajs';
import Redis from 'ioredis';
import { router } from './router.js';
import { callOllama, loadSystemPrompt, loadSessionFirstName } from './ollama.js';
import { writeActivity, writeRoutingDecision, writeToolResult, writeResult } from './activity.js';

// ── Config ───────────────────────────────────────────────────────────────────

const KAFKA_BOOTSTRAP = process.env.KAFKA_BOOTSTRAP || 'aria-kafka:9092';
const REDIS_URL       = process.env.REDIS_URL       || 'redis://aria-redis:6379/0';
const MAX_RETRIES     = 3;
const RESULT_TTL      = 86400;
const HISTORY_MAX     = 20;

const TOPIC_REQUESTS  = 'aria.requests';
const TOPIC_RESULTS   = 'aria.results.tasks';
const TOPIC_DLQ       = 'aria.dlq';

// ── Clients ──────────────────────────────────────────────────────────────────

// Suppress partitioner warning — expected in KafkaJS v2
process.env.KAFKAJS_NO_PARTITIONER_WARNING = '1';

const kafka = new Kafka({
  clientId: 'aria-orchestrator-v2',
  brokers:  [KAFKA_BOOTSTRAP],
  logLevel: logLevel.WARN,
  retry: { retries: 10, initialRetryTime: 1000 },
});

const redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 3 });

const producer = kafka.producer({
  allowAutoTopicCreation: true,
  idempotent: true,
  transactionTimeout: 30000,
});

const consumer = kafka.consumer({
  groupId: 'aria-orchestrator-v2',
  sessionTimeout: 30000,
  heartbeatInterval: 3000,
});

// ── Helpers ──────────────────────────────────────────────────────────────────

async function produce(topic, cid, taskId, payload, retry = 0) {
  const msg = {
    cid,
    task_id:  taskId,
    topic,
    ts:       new Date().toISOString(),
    retry,
    payload,
  };
  await producer.send({
    topic,
    messages: [{ key: cid, value: JSON.stringify(msg) }],
  });
}

async function loadHistory(cid) {
  const raw = await redis.lrange(`history:${cid}`, 0, HISTORY_MAX * 2);
  const turns = [];
  for (const r of raw) {
    try {
      const t = JSON.parse(r);
      if (t.role === 'user' || t.role === 'assistant') {
        turns.push({ role: t.role, content: t.content });
      }
    } catch { /* skip malformed */ }
  }
  return turns;
}

async function appendHistory(cid, role, content) {
  const entry = JSON.stringify({ role, content, ts: new Date().toISOString() });
  await redis.rpush(`history:${cid}`, entry);
  await redis.expire(`history:${cid}`, RESULT_TTL);
}

function isFirstMessage(history) {
  return !history || history.length === 0;
}

function buildUserMessage(message, firstName, isFirst) {
  // Agreed prompt contract: first name only on first message, nothing else added
  if (isFirst && firstName && firstName !== 'default-user') {
    return `${firstName}: ${message}`;
  }
  return message;
}

// ── Core handler ─────────────────────────────────────────────────────────────

async function handleRequest(envelope) {
  const cid     = envelope.cid     || '';
  const taskId  = envelope.task_id || '';
  const payload = envelope.payload || {};
  const retry   = envelope.retry   || 0;

  // Strip audit-only signals immediately — never used in processing
  const { _signals, ...cleanPayload } = payload;
  const {
    message    = '',
    username   = 'default-user',
    persona    = 'security_engineer',
    write_mode = false,
  } = cleanPayload;

  if (!cid || !taskId || !message) {
    console.warn('[orchestrator] Invalid envelope — dropping', { cid: cid.slice(0, 20) });
    return;
  }

  // First name comes from aria-ccf session key — set on first message only.
  // If key is absent, session is already in progress — name not needed.
  const displayName = await loadSessionFirstName(redis, cid);

  try {
    // ── 1. Route ────────────────────────────────────────────────────────────
    const routing = router.route(message);

    // ── 2. Write routing decision to activity pane immediately ──────────────
    await writeRoutingDecision(redis, { cid, taskId, routing });

    // ── 3. High blast radius — require user confirmation before proceeding ──
    if (routing.blastRadius === 'high' && write_mode) {
      await writeActivity(redis, {
        cid,
        taskId,
        actor:  routing.symbol,
        event:  'confirmation_required',
        detail: 'This action affects production systems. Please confirm to proceed.',
        meta:   { blastRadius: routing.blastRadius },
      });
      // Write pending result — orchestrator waits for follow-up confirmation message
      await redis.set(`result:${taskId}`, JSON.stringify({
        task_id:   taskId,
        cid,
        status:    'awaiting_confirmation',
        response:  'This action affects production systems. Please confirm to proceed.',
        timestamp: new Date().toISOString(),
      }), 'EX', RESULT_TTL);
      return;
    }

    // ── 4. Load system prompt (name only — from KV cache) ───────────────────
    const systemPrompt = await loadSystemPrompt(redis, routing.instance);

    // ── 5. Load conversation history ─────────────────────────────────────────
    const history  = await loadHistory(cid);
    // displayName is non-empty only on first message (set by aria-ccf)
    const isFirst  = !!displayName;
    const userMsg  = buildUserMessage(message, displayName, isFirst);

    // ── 6. Call selected Ollama instance ─────────────────────────────────────
    await writeActivity(redis, {
      cid,
      taskId,
      actor:  routing.symbol,
      event:  'llm_start',
      detail: `${routing.instance} processing`,
    });

    // LLM has knowledge_search in its tool list — calls it when it needs context
    const llmResult = await callOllama(routing.instance, {
      systemPrompt,
      history,
      message: userMsg,
      toolContext: { cid, taskId, redis, symbol: routing.symbol },
    });

    await writeActivity(redis, {
      cid,
      taskId,
      actor:  routing.symbol,
      event:  'llm_complete',
      detail: `${routing.instance} responded in ${llmResult.durationMs}ms`,
      meta:   { durationMs: llmResult.durationMs, model: llmResult.model },
    });

    // ── 8. Validation pass for actionable high-complexity tasks ──────────────
    let finalResponse = llmResult.content;
    let validationPassed = true;

    if (routing.intent === 'actionable' && routing.complexity > 0.6) {
      // Route to a different instance for validation
      // Validation goes to whichever instance the bandit rates highest for
      // validation tasks — not hardcoded to gamma
      const validationInstance = routing.instance === 'alpha' ? 'gamma' : 'alpha';
      const validationPrompt   = await loadSystemPrompt(redis, validationInstance);

      await writeActivity(redis, {
        cid,
        taskId,
        actor:  validationInstance === 'alpha' ? 'α' : validationInstance === 'gamma' ? 'γ' : 'β',
        event:  'validation',
        detail: `Validating ${routing.instance}'s response`,
      });

      // Lightweight validation — send response only, not full original message
      const validationMsg = `Is this response safe and accurate? Reply APPROVED or REJECTED: [reason].\n\n${llmResult.content.slice(0, 500)}`;

      const validation = await callOllama(validationInstance, {
        systemPrompt: validationPrompt,
        history:      [],
        message:      validationMsg,
      });

      validationPassed = validation.content.trim().toUpperCase().startsWith('APPROVED');

      await writeActivity(redis, {
        cid,
        taskId,
        actor:  validationInstance === 'alpha' ? 'α' : validationInstance === 'gamma' ? 'γ' : 'β',
        event:  'validation',
        detail: validationPassed ? 'Approved' : `Rejected: ${validation.content.slice(0, 100)}`,
        meta:   { validationPassed },
      });

      if (!validationPassed) {
        finalResponse = `I need to revise my response. ${validation.content.replace(/^REJECTED:?\s*/i, '')}`;
        router.recordOutcome(message, routing.instance, 'escalated');
      }
    }

    // ── 9. Append to conversation history ────────────────────────────────────
    await appendHistory(cid, 'user', message);
    await appendHistory(cid, 'assistant', finalResponse);

    // ── 10. Write result ─────────────────────────────────────────────────────
    const status = validationPassed ? 'complete' : 'revised';
    await writeResult(redis, {
      cid,
      taskId,
      status,
      response: finalResponse,
      meta: {
        instance:    routing.instance,
        symbol:      routing.symbol,
        complexity:  routing.complexity,
        intent:      routing.intent,
        blastRadius: routing.blastRadius,
        durationMs:  llmResult.durationMs,
      },
    });

    await writeActivity(redis, {
      cid,
      taskId,
      actor:  routing.symbol,
      event:  'complete',
      detail: `Done (${routing.instance}, ${llmResult.durationMs}ms)`,
    });

    // ── 11. Produce to Kafka for persistence ────────────────────────────────
    await produce(TOPIC_RESULTS, cid, taskId, {
      response:    finalResponse,
      status,
      instance:    routing.instance,
      symbol:      routing.symbol,
      complexity:  routing.complexity,
      intent:      routing.intent,
      blastRadius: routing.blastRadius,
    });

    // ── 12. Record outcome back to bandit ────────────────────────────────────
    router.recordOutcome(message, routing.instance, validationPassed ? 'success' : 'escalated');

  } catch (err) {
    console.error('[orchestrator] Handler error', { cid: cid.slice(0, 20), taskId, err: err.message });

    await writeActivity(redis, {
      cid,
      taskId,
      actor:  'system',
      event:  'error',
      detail: err.message.slice(0, 200),
    });

    await writeResult(redis, {
      cid,
      taskId,
      status:   'error',
      response: 'Something went wrong. Please try again.',
      meta:     { error: err.message.slice(0, 200) },
    });

    // Retry or DLQ
    if (retry < MAX_RETRIES) {
      await produce(TOPIC_REQUESTS, cid, taskId, payload, retry + 1);
    } else {
      await produce(TOPIC_DLQ, cid, taskId, {
        ...payload,
        error: err.message,
        exhausted: true,
      });
    }

    // Record failure to bandit — will suppress this instance if it keeps failing
    const routing = router.route(message);
    router.recordOutcome(message, routing.instance, 'failure');
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('[orchestrator] Starting aria-orchestrator v2');

  await redis.connect();
  console.log('[orchestrator] Redis connected');

  await producer.connect();
  console.log('[orchestrator] Kafka producer connected');

  await consumer.connect();
  await consumer.subscribe({ topic: TOPIC_REQUESTS, fromBeginning: false });
  console.log(`[orchestrator] Consuming ${TOPIC_REQUESTS}`);

  await consumer.run({
    eachMessage: async ({ topic, partition, message: kafkaMsg }) => {
      let envelope;
      try {
        envelope = JSON.parse(kafkaMsg.value.toString());
      } catch {
        console.warn('[orchestrator] Malformed message — skipping');
        return;
      }
      await handleRequest(envelope);
    },
  });

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    console.log('[orchestrator] SIGTERM — shutting down');
    await consumer.disconnect();
    await producer.disconnect();
    redis.disconnect();
    process.exit(0);
  });
}

main().catch(err => {
  console.error('[orchestrator] Fatal error', err);
  process.exit(1);
});
