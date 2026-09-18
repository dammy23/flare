import { createDb, provisionDefaultDashboard } from '@flare/db'
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

describe('GET /api/v1/projects/:projectId/dashboard', () => {
  it('returns the provisioned dashboard with its starter widgets', async () => {
    const project = await db
      .insertInto('project')
      .values({ name: 'Dashboard Fetch Test', slug: `dash-fetch-${Date.now()}`, public_key: `pk-dash-${Date.now()}` })
      .returningAll()
      .executeTakeFirstOrThrow()
    await provisionDefaultDashboard(db, project.id)
    const cookie = await createAuthCookie(db, redis)

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${project.id}/dashboard`,
      headers: { cookie },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.projectId).toBe(project.id)
    expect(body.widgets).toHaveLength(7)
  })

  it('returns 404 when the project has no dashboard', async () => {
    const cookie = await createAuthCookie(db, redis)
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/00000000-0000-0000-0000-000000000000/dashboard',
      headers: { cookie },
    })
    expect(response.statusCode).toBe(404)
  })

  it('returns 401 without a session', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/00000000-0000-0000-0000-000000000000/dashboard',
    })
    expect(response.statusCode).toBe(401)
  })
})
