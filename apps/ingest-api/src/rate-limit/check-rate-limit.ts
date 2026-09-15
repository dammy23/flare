import type { Redis } from 'ioredis'

export type RateLimitCategory = 'error' | 'transaction' | 'replay' | 'attachment'

export interface RateLimitResult {
  allowed: boolean
  retryAfterSeconds?: number
}

export interface RateLimitOptions {
  limit: number
  windowSeconds: number
}

export async function checkRateLimit(
  redis: Redis,
  projectId: string,
  category: RateLimitCategory,
  options: RateLimitOptions = { limit: 1000, windowSeconds: 60 }
): Promise<RateLimitResult> {
  const key = `ratelimit:${projectId}:${category}`
  const count = await redis.incr(key)
  if (count === 1) {
    await redis.expire(key, options.windowSeconds)
  }
  if (count <= options.limit) {
    return { allowed: true }
  }
  const ttl = await redis.ttl(key)
  return { allowed: false, retryAfterSeconds: ttl > 0 ? ttl : options.windowSeconds }
}
