/**
 * SSE route — GET /api/activity/[cid]
 *
 * Browser opens this connection after sending a message.
 * Server subscribes to Redis pub/sub channel activity:pubsub:{cid}.
 * Ruflo publishes to that channel on every pipeline event.
 * Events arrive instantly — no polling, no delay.
 *
 * Connection closes when:
 *   - Ruflo publishes a 'complete' or 'error' event
 *   - Browser disconnects
 *   - 5 minute timeout (safety valve)
 */

import { NextRequest } from 'next/server'
import { createSubscriber, getRedis } from '@/lib/redis'

const SSE_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

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

      function send(data: string) {
        try {
          controller.enqueue(encoder.encode(`data: ${data}\n\n`))
        } catch { /* client disconnected */ }
      }

      // Replay any events already in the list (in case browser reconnects)
      const existing = await redis.lrange(`activity:${cid}`, 0, -1)
      for (const entry of existing) {
        send(entry)
      }

      // Safety timeout
      const timeout = setTimeout(() => {
        send(JSON.stringify({ event: 'timeout', detail: 'Connection timed out' }))
        subscriber.disconnect()
        controller.close()
      }, SSE_TIMEOUT_MS)

      // Subscribe to pub/sub channel — events arrive instantly as ruflo publishes
      await subscriber.subscribe(`activity:pubsub:${cid}`, (message) => {
        send(message)

        // Close on terminal events
        try {
          const parsed = JSON.parse(message)
          if (parsed.event === 'complete' || parsed.event === 'error') {
            clearTimeout(timeout)
            // Small delay so browser receives the final event before close
            setTimeout(() => {
              subscriber.disconnect()
              controller.close()
            }, 200)
          }
        } catch { /* non-JSON message — keep connection open */ }
      })

      // Clean up if browser disconnects
      req.signal.addEventListener('abort', () => {
        clearTimeout(timeout)
        subscriber.disconnect()
        try { controller.close() } catch { /* already closed */ }
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
