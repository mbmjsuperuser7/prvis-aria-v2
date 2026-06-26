/**
 * Activity writer — every event in the pipeline writes here.
 * UI SSE stream reads activity:{cid} in real time.
 *
 * Kept separate so the wire is explicit and testable.
 * Every tool call, every routing decision, every LLM response
 * fragment goes through this module.
 */

const RESULT_TTL = 86400; // 24h

/**
 * Write one activity event to Redis.
 *
 * actor:   who produced this event — symbol (α/γ/β) or system label
 * event:   what happened — 'routing', 'llm_start', 'llm_complete',
 *          'tool_call', 'tool_result', 'validation', 'complete', 'error'
 * detail:  human-readable detail shown in activity pane
 */
export async function writeActivity(redis, { cid, taskId, actor, event, detail = '', meta = {} }) {
  const entry = JSON.stringify({
    actor,
    event,
    detail,
    cid,
    task_id:  taskId,
    ts:       new Date().toISOString(),
    ...meta,
  });

  const pipe = redis.pipeline();
  pipe.rpush(`activity:${cid}`, entry);
  pipe.expire(`activity:${cid}`, RESULT_TTL);
  if (taskId) {
    pipe.rpush(`activity:${taskId}`, entry);
    pipe.expire(`activity:${taskId}`, RESULT_TTL);
  }
  // Publish to Redis pub/sub channel — Next.js subscribes and pushes to browser instantly
  pipe.publish(`activity:pubsub:${cid}`, entry);
  await pipe.exec();
}

/**
 * Write routing decision — shown immediately in activity pane
 * so user sees which instance is handling their message.
 */
export async function writeRoutingDecision(redis, { cid, taskId, routing }) {
  await writeActivity(redis, {
    cid,
    taskId,
    actor:  routing.symbol,
    event:  'routing',
    detail: routing.reasoning,
    meta: {
      instance:    routing.instance,
      complexity:  routing.complexity,
      intent:      routing.intent,
      blastRadius: routing.blastRadius,
    },
  });
}

/**
 * Write tool call result — this is the missing wire from T1.5.
 * Every tool call result now appears in the activity pane.
 */
export async function writeToolResult(redis, { cid, taskId, actor, tool, input, output, success, durationMs }) {
  await writeActivity(redis, {
    cid,
    taskId,
    actor,
    event:  'tool_result',
    detail: `${tool} → ${success ? 'ok' : 'failed'} (${durationMs}ms)`,
    meta: {
      tool,
      input:   JSON.stringify(input).slice(0, 200),
      output:  String(output).slice(0, 500),
      success,
      durationMs,
    },
  });
}

/**
 * Write final result to Redis for UI polling.
 */
export async function writeResult(redis, { cid, taskId, status, response, meta = {} }) {
  const result = {
    task_id:   taskId,
    cid,
    status,
    response,
    timestamp: new Date().toISOString(),
    ...meta,
  };
  await redis.set(`result:${taskId}`, JSON.stringify(result), 'EX', RESULT_TTL);

  // Also append to conversation history
  return result;
}
