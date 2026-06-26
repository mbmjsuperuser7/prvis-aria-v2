/**
 * Result polling — GET /api/result/[taskId]
 * Returns current task status and response from Redis.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getRedis } from '@/lib/redis'

export async function GET(
  _req: NextRequest,
  { params }: { params: { taskId: string } }
) {
  const redis = getRedis()
  const raw   = await redis.get(`result:${params.taskId}`)

  if (!raw) {
    return NextResponse.json({ task_id: params.taskId, status: 'pending' })
  }

  return NextResponse.json(JSON.parse(raw))
}
