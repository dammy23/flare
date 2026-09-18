import Redis from 'ioredis'
import { afterAll, describe, expect, it } from 'vitest'
import { createSession, destroySession, getSession } from './session'

const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379')

afterAll(() => redis.disconnect())

describe('session', () => {
  it('creates a session that can be looked up by its id', async () => {
    const sessionId = await createSession(redis, { userId: 'user-1', isAdmin: false })
    const session = await getSession(redis, sessionId)
    expect(session).toEqual({ userId: 'user-1', isAdmin: false })
  })

  it('returns null for an unknown session id', async () => {
    const session = await getSession(redis, 'not-a-real-session-id')
    expect(session).toBeNull()
  })

  it('returns null after a session is destroyed', async () => {
    const sessionId = await createSession(redis, { userId: 'user-2', isAdmin: true })
    await destroySession(redis, sessionId)
    expect(await getSession(redis, sessionId)).toBeNull()
  })
})
