/**
 * Tool call handler — the orchestrator's execution layer.
 *
 * When an LLM calls a tool, the orchestrator intercepts it here,
 * executes the real tool, writes the result to the activity pane,
 * and returns the result to the LLM so it can continue reasoning.
 *
 * Tools available to the LLM:
 *   knowledge_search — search standards, playbooks, tools, user ACiDF
 *
 * More tools added here as the tool registry grows (shell, ssh_exec, etc.)
 * Each tool call result is written to activity:{cid} so the user sees it.
 */

import { knowledgeSearch } from './rag.js'

// Tool endpoint URLs — passed from environment, used when tool handlers are added
export const TOOL_ENDPOINTS = {
  proxmox:    process.env.PROXMOX_URL    || '',
  guacamole:  process.env.GUACAMOLE_URL  || 'http://aria-guacamole:8080',
  wazuh:      process.env.WAZUH_URL      || '',
  fleet:      process.env.FLEET_URL      || '',
  defectdojo: process.env.DEFECTDOJO_URL || '',
  thehive:    process.env.THEHIVE_URL    || '',
  tavily:     process.env.TAVILY_API_KEY || '',
}
import { writeToolResult } from './activity.js'

const AVAILABLE_TOOLS = {
  knowledge_search: {
    description: 'Search the knowledge base — standards, playbooks, tool registry, user history',
    parameters: {
      query:   { type: 'string',  required: true,  description: 'What to search for' },
      sources: { type: 'array',   required: false, description: 'Filter by source prefix e.g. ["playbook/", "knowledge/standards/"]' },
      top_k:   { type: 'integer', required: false, description: 'Number of results (default 3)' },
    },
  },
}

/**
 * Execute one tool call from the LLM.
 * Returns the result as a string the LLM can reason against.
 */
export async function handleToolCall(toolName, args, { cid, taskId, redis, symbol }) {
  const start = Date.now()
  let result
  let success = true

  try {
    switch (toolName) {
      case 'knowledge_search': {
        const res = await knowledgeSearch(args, { cid })
        if (res.error) {
          result  = `knowledge_search error: ${res.error}`
          success = false
        } else if (!res.chunks?.length) {
          result = 'No relevant knowledge found.'
        } else {
          // Format chunks for LLM consumption — source attributed, concise
          result = res.chunks
            .map(c => `[${c.source}]\n${c.content}`)
            .join('\n\n---\n\n')
        }
        break
      }

      default:
        result  = `Unknown tool: ${toolName}`
        success = false
    }
  } catch (err) {
    result  = `Tool execution error: ${err.message}`
    success = false
  }

  const durationMs = Date.now() - start

  // Write tool result to activity pane — user sees what was searched and found
  await writeToolResult(redis, {
    cid,
    taskId,
    actor:     symbol || 'system',
    tool:      toolName,
    input:     args,
    output:    result,
    success,
    durationMs,
  })

  return result
}
