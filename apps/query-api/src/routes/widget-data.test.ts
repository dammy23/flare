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

describe('GET /api/v1/widgets/:id/data', () => {
  it('returns data for a provisioned widget and caches the response', async () => {
    const project = await db
      .insertInto('project')
      .values({ name: 'Widget Data Test', slug: `widget-data-${Date.now()}`, public_key: `pk-widget-data-${Date.now()}` })
      .returningAll()
      .executeTakeFirstOrThrow()
    const dashboardId = await provisionDefaultDashboard(db, project.id)
    const widget = await db
      .selectFrom('dashboard_widget')
      .selectAll()
      .where('dashboard_id', '=', dashboardId)
      .where('widget_type', '=', 'new_issues')
      .executeTakeFirstOrThrow()

    const cookie = await createAuthCookie(db, redis)
    const response = await app.inject({ method: 'GET', url: `/api/v1/widgets/${widget.id}/data`, headers: { cookie } })

    expect(response.statusCode).toBe(200)
    expect(Array.isArray(response.json().data)).toBe(true)

    const cacheKeys = await redis.keys('widgetdata:*')
    expect(cacheKeys.length).toBeGreaterThan(0)
  })

  it('returns 404 for an unknown widget', async () => {
    const cookie = await createAuthCookie(db, redis)
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/widgets/00000000-0000-0000-0000-000000000000/data',
      headers: { cookie },
    })
    expect(response.statusCode).toBe(404)
  })

  it('returns 401 without a session', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/widgets/00000000-0000-0000-0000-000000000000/data',
    })
    expect(response.statusCode).toBe(401)
  })
})
