import { createDb, createUser } from '@flare/db'
import Redis from 'ioredis'
import { afterAll, describe, expect, it } from 'vitest'
import { buildApp } from '../app'
import { createAuthCookie } from '../auth/test-auth-helper'
import { createSession } from '../auth/session'
import { SESSION_COOKIE_NAME } from '../auth/current-user'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379')
const queueConnection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
  lazyConnect: true,
})
const app = buildApp({ db, redis, storage: {} as never, queueConnection, cookieSecret: 'test-secret' })

afterAll(async () => {
  await db.destroy()
  redis.disconnect()
  queueConnection.disconnect()
  await app.close()
})

describe('GET /api/v1/users', () => {
  it('lists users for an admin', async () => {
    const cookie = await createAuthCookie(db, redis, { isAdmin: true })
    const response = await app.inject({ method: 'GET', url: '/api/v1/users', headers: { cookie } })
    expect(response.statusCode).toBe(200)
    expect(Array.isArray(response.json())).toBe(true)
  })

  it('returns 403 for a non-admin user', async () => {
    const cookie = await createAuthCookie(db, redis, { isAdmin: false })
    const response = await app.inject({ method: 'GET', url: '/api/v1/users', headers: { cookie } })
    expect(response.statusCode).toBe(403)
  })
})

describe('PATCH /api/v1/users/:id', () => {
  it('promotes another user to admin', async () => {
    const adminCookie = await createAuthCookie(db, redis, { isAdmin: true })
    const target = await createUser(db, {
      email: `promote-target-${Date.now()}@example.test`,
      passwordHash: 'irrelevant',
      name: 'Promote Target',
      isAdmin: false,
    })

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${target.id}`,
      headers: { cookie: adminCookie },
      payload: { isAdmin: true },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().isAdmin).toBe(true)
  })

  it('returns 400 when an admin tries to remove their own admin access', async () => {
    const admin = await createUser(db, {
      email: `self-demote-${Date.now()}@example.test`,
      passwordHash: 'irrelevant',
      name: 'Self Demote',
      isAdmin: true,
    })
    const sessionId = await createSession(redis, { userId: admin.id, isAdmin: true })
    const cookie = `${SESSION_COOKIE_NAME}=${sessionId}`

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${admin.id}`,
      headers: { cookie },
      payload: { isAdmin: false },
    })
    expect(response.statusCode).toBe(400)
  })

  it('returns 403 for a non-admin user', async () => {
    const cookie = await createAuthCookie(db, redis, { isAdmin: false })
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/users/00000000-0000-0000-0000-000000000000',
      headers: { cookie },
      payload: { isAdmin: true },
    })
    expect(response.statusCode).toBe(403)
  })
})
