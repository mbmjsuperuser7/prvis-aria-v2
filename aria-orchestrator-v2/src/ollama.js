/**
 * Ollama client for Aria's three instances.
 *
 * Supports Ollama's native tool call format.
 * When the LLM calls a tool, the orchestrator executes it and
 * returns the result in a follow-up message. The LLM continues
 * reasoning until it produces a final text response.
 *
 * Prompt contract (agreed):
 *   First message in session:  [user first name] + [user message]
 *   Subsequent messages:       [user message]
 *   Tools:                     LLM calls when needed — never pre-fed
 */

import { handleToolCall } from './tools.js'

const INSTANCES = {
  alpha: {
    url:    process.env.ALPHA_OLLAMA_URL || 'http://192.168.1.9:11434',
    model:  process.env.ALPHA_MODEL      || 'qwen3:30b-a3b',
    symbol: 'α',
  },
  gamma: {
    url:    process.env.GAMMA_OLLAMA_URL || 'http://100.66.170.90:11434',
    model:  process.env.GAMMA_MODEL      || 'qwen3:14b',
    symbol: 'γ',
  },
  beta: {
    url:    process.env.BETA_OLLAMA_URL  || 'http://192.168.1.9:11434',
    model:  process.env.BETA_MODEL       || 'qwen3:8b',
    symbol: 'β',
  },
}

const OLLAMA_TIMEOUT_MS = parseInt(process.env.OLLAMA_TIMEOUT_MS || '120000')
const MAX_TOOL_ROUNDS   = 5  // max tool call iterations before forcing a final response

/**
 * Call an Ollama instance with tool call support.
 * Handles the tool call loop — LLM calls tools, gets results, continues until final response.
 */
export async function callOllama(instanceName, {
  message,
  toolContext,   // { cid, taskId, redis, symbol } — needed for tool execution
}) {
  const inst = INSTANCES[instanceName]
  if (!inst) throw new Error(`Unknown instance: ${instanceName}`)

  // Prompt contract: user message only. No history padding.
  const messages = [{ role: 'user', content: message }]

  const start = Date.now()

  // Log what we're sending to Ollama
  console.log(`[ollama] instance=${instanceName} model=${inst.model} messages=${JSON.stringify(messages)}`)

  // Tool call loop — LLM may call tools multiple times before final response
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const body = {
      model:    inst.model,
      messages,
      stream:   false,
      options:  { temperature: 0.7, num_ctx: 8192 },
    }

    // Identity baked into modelfile — no system prompt injection needed

    const controller = new AbortController()
    const timeout    = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS)

    let data
    try {
      const res = await fetch(`${inst.url}/api/chat`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
        signal:  controller.signal,
      })

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`Ollama ${instanceName} HTTP ${res.status}: ${text.slice(0, 200)}`)
      }

      data = await res.json()
    } finally {
      clearTimeout(timeout)
    }

    const responseMsg = data.message || {}

    // LLM produced a final text response — done
    if (responseMsg.content && !responseMsg.tool_calls?.length) {
      return {
        content:    responseMsg.content,
        instance:   instanceName,
        symbol:     inst.symbol,
        model:      inst.model,
        durationMs: Date.now() - start,
        toolRounds: round,
      }
    }

    // LLM called one or more tools — execute them and feed results back
    if (responseMsg.tool_calls?.length) {
      // Add the assistant's tool call message to history
      messages.push({ role: 'assistant', content: '', tool_calls: responseMsg.tool_calls })

      // Execute each tool call and add results
      for (const toolCall of responseMsg.tool_calls) {
        const toolName = toolCall.function?.name
        const toolArgs = toolCall.function?.arguments || {}

        const result = await handleToolCall(toolName, toolArgs, {
          cid:    toolContext?.cid,
          taskId: toolContext?.taskId,
          redis:  toolContext?.redis,
          symbol: inst.symbol,
        })

        // Add tool result to messages — LLM will see it on next round
        messages.push({
          role:        'tool',
          tool_call_id: toolCall.id || toolName,
          content:     result,
        })
      }

      // Continue to next round — LLM will reason against tool results
      continue
    }

    // Empty response — stop
    break
  }

  // Max tool rounds reached — return what we have
  const lastContent = messages
    .filter(m => m.role === 'assistant' && m.content)
    .pop()?.content || 'I was unable to complete the task.'

  return {
    content:    lastContent,
    instance:   instanceName,
    symbol:     inst.symbol,
    model:      inst.model,
    durationMs: Date.now() - start,
    toolRounds: MAX_TOOL_ROUNDS,
  }
}


/**
 * Load first name for a session — set by aria-ccf on first message only.
 * Empty string means session already in progress.
 */
export async function loadSessionFirstName(redis, cid) {
  try {
    return await redis.get(`ccf:session:${cid}`) || ''
  } catch {
    return ''
  }
}
