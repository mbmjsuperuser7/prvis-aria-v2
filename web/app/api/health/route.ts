/**
 * Health check — checks Kafka reachability via a lightweight Redis ping.
 * aria-intake no longer exists — health reflects the frontend container itself
 * plus its two dependencies: Redis and the RAG service.
 */
import { NextResponse } from 'next/server'
import { getRedis } from '@/lib/redis'

const RAG_URL = process.env.RAG_URL || 'http://aria-rag:8300'

export async function GET() {
  const checks: Record<string, boolean> = {}

  // Redis
  try {
    const redis = getRedis()
    await redis.ping()
    checks.redis = true
  } catch {
    checks.redis = false
  }

  // RAG service
  try {
    const r = await fetch(`${RAG_URL}/health`, { cache: 'no-store', signal: AbortSignal.timeout(2000) })
    checks.rag = r.ok
  } catch {
    checks.rag = false
  }

  const ok = Object.values(checks).every(Boolean)
  return NextResponse.json({ ok, checks, service: 'aria-web' }, { status: ok ? 200 : 503 })
}
