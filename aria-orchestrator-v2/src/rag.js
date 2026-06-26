/**
 * RAG as a tool — called by the LLM when it decides it needs knowledge.
 *
 * The LLM is told in its tool registry (KV cache):
 *   knowledge_search(query, sources?) — search the knowledge base
 *
 * When the LLM calls this tool, the orchestrator executes it,
 * writes the result to the activity pane, and returns it to the LLM.
 * The LLM reads it, reasons against it, decides if it needs more.
 *
 * The LLM drives this. The orchestrator never pre-fetches or decides
 * what context the LLM needs.
 */

const RAG_URL     = process.env.RAG_URL     || 'http://aria-rag:8300'
const RAG_TIMEOUT = parseInt(process.env.RAG_TIMEOUT_MS || '5000')

/**
 * Execute a knowledge_search tool call from the LLM.
 * Called by handleToolCall in index.js.
 *
 * args: { query, sources?, top_k? }
 * cid:  used to scope ACiDF results to this user
 *
 * Returns array of { content, source, score } chunks.
 */
export async function knowledgeSearch(args, { cid }) {
  const { query, sources, top_k = 3 } = args

  if (!query?.trim()) {
    return { error: 'query is required' }
  }

  const controller = new AbortController()
  const timeout    = setTimeout(() => controller.abort(), RAG_TIMEOUT)

  try {
    const res = await fetch(`${RAG_URL}/search`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ query, cid, top_k, sources }),
      signal:  controller.signal,
    })

    if (!res.ok) {
      return { error: `RAG search failed: ${res.status}` }
    }

    const chunks = await res.json()
    return { chunks: chunks || [] }

  } catch (err) {
    if (err.name === 'AbortError') {
      return { error: 'knowledge_search timed out' }
    }
    return { error: `knowledge_search unavailable: ${err.message}` }
  } finally {
    clearTimeout(timeout)
  }
}
