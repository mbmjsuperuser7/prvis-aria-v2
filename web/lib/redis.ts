/**
 * Redis client singleton for Next.js.
 * One connection for reads/writes, one for pub/sub subscriptions.
 * Pub/sub requires a dedicated connection — cannot share with regular commands.
 */
import Redis from 'ioredis'

const REDIS_URL = process.env.REDIS_URL || 'redis://aria-redis:6379/0'

let client: Redis | null = null

export function getRedis(): Redis {
  if (!client) {
    client = new Redis(REDIS_URL, {
      lazyConnect:          false,
      maxRetriesPerRequest: 3,
      enableReadyCheck:     true,
    })
  }
  return client
}

/**
 * Create a fresh Redis connection for pub/sub.
 * Must be a dedicated connection — calling subscribe() blocks it for pub/sub only.
 * Caller is responsible for calling .disconnect() when done.
 */
export function createSubscriber(): Redis {
  return new Redis(REDIS_URL, {
    lazyConnect:          false,
    maxRetriesPerRequest: 3,
  })
}
