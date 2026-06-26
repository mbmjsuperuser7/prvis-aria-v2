'use server'
/**
 * Server action — signal capture, CiD assembly, Kafka production.
 *
 * This is the entire frontend intake layer. No aria-intake container.
 * Runs on the Next.js server. Browser never sees any of this logic.
 *
 * Prompt contract:
 *   First message:  [user first name] + [user message]  (aria-ccf handles this)
 *   Subsequent:     [user message]
 *   LLM never receives: CiD, signals, session metadata
 */

import { headers } from 'next/headers'
import crypto from 'crypto'
import { produceRequest } from '@/lib/kafka'
import { getRedis } from '@/lib/redis'

export interface ChatPayload {
  message:  string
  cid?:     string
  persona?: string
}

export interface ChatResult {
  task_id:  string
  cid:      string
  status:   'queued' | 'error'
  error?:   string
}

const RESULT_TTL       = 86400
const TOKEN_BUDGET     = parseInt(process.env.TOKEN_BUDGET || '100000')
const DEFAULT_TENANT   = process.env.DEFAULT_TENANT_ID || 'prvis'
const DEFAULT_ORG      = process.env.DEFAULT_ORG_ID    || 'prvis'

// ── Forbidden patterns — blocked before Kafka ────────────────────────────────
// Network scanning, credential stuffing, prompt injection
const FORBIDDEN: Array<[RegExp, string]> = [
  [/scan\s+(all\s+)?(ip|network|subnet|range)/i,               'network_scan'],
  [/(nmap|masscan|zmap)\b/i,                                    'network_scan_tool'],
  [/ip\s+(range|sweep|scan)/i,                                  'ip_range_scan'],
  [/(brute.?force|credential.?stuff)/i,                         'credential_stuffing'],
  [/ignore\s+(previous|all|your)\s+instructions/i,              'prompt_injection'],
  [/you\s+are\s+now\s+/i,                                       'prompt_injection'],
  [/(jailbreak|developer\s+mode|bypass\s+your|override\s+your)/i,'prompt_injection'],
  [/(reveal|print|show)\s+your\s+(system\s+)?prompt/i,          'prompt_injection'],
  [/lateral\s+movement/i,                                       'lateral_movement'],
]

function checkForbidden(message: string): string | null {
  for (const [pattern, type] of FORBIDDEN) {
    if (pattern.test(message)) return type
  }
  return null
}

// ── CiD assembly ─────────────────────────────────────────────────────────────

function assembleCiD(tenantId: string, orgId: string, username: string, sessionKey: string): string {
  const ucid = Array.from(crypto.getRandomValues(new Uint8Array(10)))
    .map(b => b % 10).join('')
  const hash = crypto.createHash('sha256').update(`${tenantId}:${username}`).digest('hex')
  const uuid = String(parseInt(hash.slice(0, 8), 16) % 100_000_000).padStart(8, '0')
  return `${ucid}:${uuid}:${tenantId}:${orgId}:${username}:${sessionKey}:${Date.now()}`
}

function makeTaskId(cid: string): string {
  return crypto.createHash('sha256')
    .update(`${cid}:${Date.now()}:${Math.random()}`)
    .digest('hex').slice(0, 32)
}

// ── Signal capture ────────────────────────────────────────────────────────────

function captureSignals(h: Headers): Record<string, string> {
  return {
    src_ip:      h.get('x-forwarded-for')?.split(',')[0]?.trim() || h.get('x-real-ip') || '',
    user_agent:  h.get('user-agent') || '',
    referer:     h.get('referer') || '',
    language:    h.get('accept-language')?.split(',')[0] || '',
    browser:     h.get('x-aria-browser') || '',
    os:          h.get('x-aria-os') || '',
    screen:      h.get('x-aria-screen') || '',
    timezone:    h.get('x-aria-tz') || '',
    fingerprint: h.get('x-aria-fingerprint') || '',
    session:     h.get('x-aria-session') || '',
  }
}

// ── Token budget ──────────────────────────────────────────────────────────────

async function checkBudget(tenantId: string): Promise<boolean> {
  const redis = getRedis()
  const hour  = new Date().toISOString().slice(0, 13).replace('T', ':')
  const key   = `budget:${tenantId}:${hour}`
  const used  = parseInt(await redis.get(key) || '0')
  return used < TOKEN_BUDGET
}

// ── Server action ─────────────────────────────────────────────────────────────

export async function sendMessage(payload: ChatPayload): Promise<ChatResult> {
  const h       = headers()
  const redis   = getRedis()
  const signals = captureSignals(h)

  // Identity — in production from Keycloak JWT; for now from session headers
  const tenantId   = DEFAULT_TENANT
  const orgId      = DEFAULT_ORG
  const username   = h.get('x-aria-username') || 'default-user'
  const sessionKey = signals.session || crypto.randomBytes(8).toString('hex')

  // Forbidden pattern check — before anything else
  const violation = checkForbidden(payload.message)
  if (violation) {
    return { task_id: '', cid: '', status: 'error', error: `Request type not permitted: ${violation}` }
  }

  // Budget check
  if (!await checkBudget(tenantId)) {
    return { task_id: '', cid: '', status: 'error', error: 'Token budget exhausted' }
  }

  // CiD — continue existing conversation or start new one
  const cid    = payload.cid || assembleCiD(tenantId, orgId, username, sessionKey)
  const taskId = makeTaskId(cid)

  // Register task in Redis before Kafka — UI can poll immediately
  await redis.multi()
    .rpush(`tasks:${cid}`, taskId)
    .expire(`tasks:${cid}`, RESULT_TTL)
    .set(`result:${taskId}`, JSON.stringify({
      task_id:   taskId,
      cid,
      status:    'pending',
      timestamp: new Date().toISOString(),
    }), 'EX', RESULT_TTL)
    .exec()

  // Session tracking
  await redis.multi()
    .sadd(`sessions:${tenantId}:${username}`, cid)
    .expire(`sessions:${tenantId}:${username}`, RESULT_TTL * 30)
    .exec()

  // Produce to Kafka — durable from this point
  // Signals go in envelope metadata — never in payload that reaches LLM
  const produced = await produceRequest({
    cid,
    task_id: taskId,
    payload: {
      message:    payload.message,
      persona:    payload.persona || 'security_engineer',
      username,
      tenant_id:  tenantId,
      org_id:     orgId,
      // Signals: for audit only — orchestrator passes to aria-audit, never to LLM
      _signals:   signals,
    },
  })

  if (!produced) {
    // Kafka unavailable — tell user clearly, don't lose message silently
    await redis.set(`result:${taskId}`, JSON.stringify({
      task_id: taskId, cid, status: 'error',
      response: 'Message delivery failed — please try again',
      timestamp: new Date().toISOString(),
    }), 'EX', RESULT_TTL)
    return { task_id: taskId, cid, status: 'error', error: 'Message delivery failed — please try again' }
  }

  return { task_id: taskId, cid, status: 'queued' }
}
