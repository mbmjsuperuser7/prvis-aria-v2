/**
 * SSE route — GET /api/activity/[cid]
 *
 * Browser opens this connection after sending a message.
 * Server subscribes to Redis pub/sub channel activity:pubsub:{cid}.
 * Ruflo publishes to that channel on every pipeline event.
 * Events arrive instantly — no polling, no delay.
 */

import { NextRequest } from 'next/server'
import { createSubscriber, getRedis } from '@/lib/redis'

const SSE_TIMEOUT_MS = 5 * 60 * 1000

export async function GET(
  req: NextRequest,
  { params }: { params: { cid: string } }
) {
  const { cid } = params
  if (!cid) {
    return new Response('Missing cid', { status: 400 })
  }

  const redis      = getRedis()
  const subscriber = createSubscriber()

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder()
      let closed = false

      function send(data: string) {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`data: ${data}\n\n`))
        } catch { /* client disconnected */ }
      }

      function close() {
        if (closed) return
        closed = true
        subscriber.disconnect()
        try { controller.close() } catch { /* already closed */ }
      }

      // Replay existing events on reconnect
      const existing = await redis.lrange(`activity:${cid}`, 0, -1)
      for (const entry of existing) {
        send(entry)
      }

      // Safety timeout
      const timeout = setTimeout(() => {
        send(JSON.stringify({ event: 'timeout', detail: 'Connection timed out' }))
        close()
      }, SSE_TIMEOUT_MS)

      // Use on('message') — properly typed as (channel: string, message: string)
      subscriber.on('message', (channel: string, message: string) => {
        send(message)
        try {
          const parsed = JSON.parse(message)
          if (parsed.event === 'complete' || parsed.event === 'error') {
            clearTimeout(timeout)
            setTimeout(close, 200)
          }
        } catch { /* non-JSON — keep open */ }
      })

      await subscriber.subscribe(`activity:pubsub:${cid}`)

      req.signal.addEventListener('abort', () => {
        clearTimeout(timeout)
        close()
      })
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type':      'text/event-stream',
      'Cache-Control':     'no-cache',
      'Connection':        'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
