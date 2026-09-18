import type { Kysely } from 'kysely'
import type { Database } from '@flare/db'
import { createUser } from '@flare/db'
import type { Redis } from 'ioredis'
import { createSession } from './session'
import { SESSION_COOKIE_NAME } from './current-user'

/**
 * Creates a real user + session and returns a `Cookie` header value ready
 * to pass to `app.inject({ headers: { cookie } })` -- every route except
 * /api/v1/auth/register and /api/v1/auth/login now requires a session,
 * per app.ts's global auth hook.
 */
export async function createAuthCookie(
  db: Kysely<Database>,
  redis: Redis,
  overrides: { isAdmin?: boolean } = {}
): Promise<string> {
  const user = await createUser(db, {
    email: `test-auth-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
    passwordHash: 'unused-in-tests-sessions-are-created-directly',
    name: 'Test User',
    isAdmin: overrides.isAdmin ?? false,
  })
  const sessionId = await createSession(redis, { userId: user.id, isAdmin: user.isAdmin })
  return `${SESSION_COOKIE_NAME}=${sessionId}`
}
