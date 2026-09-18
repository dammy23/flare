import { createDb } from '@flare/db'
import Redis from 'ioredis'
import { afterAll, describe, expect, it } from 'vitest'
import { buildApp } from './app'
import { createAuthCookie } from './auth/test-auth-helper'

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

describe('GET /healthz', () => {
  it('is reachable without a session', async () => {
    const response = await app.inject({ method: 'GET', url: '/healthz' })
    expect(response.statusCode).toBe(200)
  })
})

describe('GET /admin/queues (Bull Board)', () => {
  it('returns 401 without a session', async () => {
    const response = await app.inject({ method: 'GET', url: '/admin/queues' })
    expect(response.statusCode).toBe(401)
  })

  it('returns 403 for a non-admin session', async () => {
    const cookie = await createAuthCookie(db, redis, { isAdmin: false })
    const response = await app.inject({ method: 'GET', url: '/admin/queues', headers: { cookie } })
    expect(response.statusCode).toBe(403)
  })

  it('is reachable for an admin session', async () => {
    const cookie = await createAuthCookie(db, redis, { isAdmin: true })
    const response = await app.inject({ method: 'GET', url: '/admin/queues', headers: { cookie } })
    expect(response.statusCode).not.toBe(401)
    expect(response.statusCode).not.toBe(403)
  })
})
