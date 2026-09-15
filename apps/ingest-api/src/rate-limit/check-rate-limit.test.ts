import Redis from 'ioredis'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { checkRateLimit } from './check-rate-limit'

const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379')
const projectId = 'rate-limit-test-project'

afterEach(async () => {
  await redis.del(`ratelimit:${projectId}:error`)
})

afterAll(() => redis.disconnect())

describe('checkRateLimit', () => {
  it('allows requests under the limit', async () => {
    const result = await checkRateLimit(redis, projectId, 'error', { limit: 5, windowSeconds: 60 })
    expect(result.allowed).toBe(true)
  })

  it('blocks requests once the limit is exceeded', async () => {
    for (let i = 0; i < 3; i += 1) {
      await checkRateLimit(redis, projectId, 'error', { limit: 3, windowSeconds: 60 })
    }
    const result = await checkRateLimit(redis, projectId, 'error', { limit: 3, windowSeconds: 60 })
    expect(result.allowed).toBe(false)
    expect(result.retryAfterSeconds).toBeGreaterThan(0)
  })
})
