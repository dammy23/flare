import type { FastifyInstance } from 'fastify'
import { countUsers, createUser, findUserByEmail, findUserById } from '@flare/db'
import { hashPassword, verifyPassword } from '../auth/hash-password'
import { createSession, destroySession } from '../auth/session'
import { SESSION_COOKIE_NAME } from '../auth/current-user'

const SESSION_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60

function sessionCookieOptions() {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
  }
}

export function registerAuthRoutes(app: FastifyInstance): void {
  app.post<{ Body: { email: string; password: string; name: string } }>(
    '/api/v1/auth/register',
    async (request, reply) => {
      const { db, redis } = app.deps
      const { email, password, name } = request.body ?? {}

      if (!email || !password || !name) {
        return reply.code(400).send({ error: 'email, password, and name are required' })
      }
      if (password.length < 8) {
        return reply.code(400).send({ error: 'password must be at least 8 characters' })
      }

      const existing = await findUserByEmail(db, email)
      if (existing) return reply.code(409).send({ error: 'email already registered' })

      // The very first user to ever register becomes admin -- bootstraps
      // the system without a manual DB edit. Everyone after that
      // registers as a regular member.
      const isFirstUser = (await countUsers(db)) === 0
      const passwordHash = await hashPassword(password)
      const user = await createUser(db, { email, passwordHash, name, isAdmin: isFirstUser })

      const sessionId = await createSession(redis, { userId: user.id, isAdmin: user.isAdmin })
      reply.setCookie(SESSION_COOKIE_NAME, sessionId, sessionCookieOptions())

      return reply.code(201).send({ user })
    }
  )

  app.post<{ Body: { email: string; password: string } }>('/api/v1/auth/login', async (request, reply) => {
    const { db, redis } = app.deps
    const { email, password } = request.body ?? {}

    const found = email ? await findUserByEmail(db, email) : undefined
    if (!found || !(await verifyPassword(password ?? '', found.passwordHash))) {
      return reply.code(401).send({ error: 'invalid email or password' })
    }

    const sessionId = await createSession(redis, { userId: found.id, isAdmin: found.isAdmin })
    reply.setCookie(SESSION_COOKIE_NAME, sessionId, sessionCookieOptions())

    return { user: { id: found.id, email: found.email, name: found.name, isAdmin: found.isAdmin } }
  })

  app.post('/api/v1/auth/logout', async (request, reply) => {
    const sessionId = request.cookies[SESSION_COOKIE_NAME]
    if (sessionId) await destroySession(app.deps.redis, sessionId)
    reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' })
    return { status: 'ok' }
  })

  app.get('/api/v1/me', async (request, reply) => {
    if (!request.currentUser) return reply.code(401).send({ error: 'unauthorized' })
    const user = await findUserById(app.deps.db, request.currentUser.id)
    if (!user) return reply.code(401).send({ error: 'unauthorized' })
    return { user }
  })
}
