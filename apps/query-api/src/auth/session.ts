import { randomBytes } from 'node:crypto'
import type { Redis } from 'ioredis'

export interface SessionPayload {
  userId: string
  isAdmin: boolean
}

const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60 // 7 days
const SESSION_KEY_PREFIX = 'session:'

export async function createSession(redis: Redis, payload: SessionPayload): Promise<string> {
  const sessionId = randomBytes(32).toString('hex')
  await redis.set(`${SESSION_KEY_PREFIX}${sessionId}`, JSON.stringify(payload), 'EX', SESSION_TTL_SECONDS)
  return sessionId
}

export async function getSession(redis: Redis, sessionId: string): Promise<SessionPayload | null> {
  const raw = await redis.get(`${SESSION_KEY_PREFIX}${sessionId}`)
  if (!raw) return null
  return JSON.parse(raw) as SessionPayload
}

export async function destroySession(redis: Redis, sessionId: string): Promise<void> {
  await redis.del(`${SESSION_KEY_PREFIX}${sessionId}`)
}
