import { createDb } from '@flare/db'
import Redis from 'ioredis'
import { afterAll, describe, expect, it } from 'vitest'
import { buildApp } from '../app'
import { createAuthCookie } from '../auth/test-auth-helper'

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

describe('POST /api/v1/projects', () => {
  it('creates a project with a generated public key and an auto-provisioned dashboard', async () => {
    const cookie = await createAuthCookie(db, redis, { isAdmin: true })
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie },
      payload: { name: 'New App', slug: `new-app-${Date.now()}` },
    })

    expect(response.statusCode).toBe(201)
    const body = response.json()
    expect(body.publicKey).toBeTruthy()

    const dashboard = await db
      .selectFrom('dashboard')
      .selectAll()
      .where('project_id', '=', body.id)
      .executeTakeFirstOrThrow()
    expect(dashboard.id).toBe(body.dashboardId)

    const widgets = await db.selectFrom('dashboard_widget').selectAll().where('dashboard_id', '=', dashboard.id).execute()
    expect(widgets).toHaveLength(7)
  })

  it('rejects a duplicate slug', async () => {
    const cookie = await createAuthCookie(db, redis, { isAdmin: true })
    const slug = `dup-${Date.now()}`
    await app.inject({ method: 'POST', url: '/api/v1/projects', headers: { cookie }, payload: { name: 'A', slug } })
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie },
      payload: { name: 'B', slug },
    })
    expect(response.statusCode).toBe(409)
  })

  it('returns 403 for a non-admin user', async () => {
    const cookie = await createAuthCookie(db, redis, { isAdmin: false })
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie },
      payload: { name: 'Not Allowed', slug: `not-allowed-${Date.now()}` },
    })
    expect(response.statusCode).toBe(403)
  })

  it('returns 401 without a session', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: 'No Session', slug: `no-session-${Date.now()}` },
    })
    expect(response.statusCode).toBe(401)
  })
})
