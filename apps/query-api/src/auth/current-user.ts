import type { FastifyRequest } from 'fastify'
import type { Redis } from 'ioredis'
import { getSession } from './session'

export interface CurrentUser {
  id: string
  isAdmin: boolean
}

export const SESSION_COOKIE_NAME = 'flare_session'

export async function getCurrentUser(request: FastifyRequest, redis: Redis): Promise<CurrentUser | null> {
  const sessionId = request.cookies[SESSION_COOKIE_NAME]
  if (!sessionId) return null

  const session = await getSession(redis, sessionId)
  if (!session) return null

  return { id: session.userId, isAdmin: session.isAdmin }
}
