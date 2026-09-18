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

async function seedDashboard() {
  const project = await db
    .insertInto('project')
    .values({ name: 'Widget CRUD Test', slug: `widget-crud-${Date.now()}`, public_key: `pk-crud-${Date.now()}` })
    .returningAll()
    .executeTakeFirstOrThrow()
  const dashboardId = await provisionDefaultDashboard(db, project.id)
  return { project, dashboardId }
}

describe('widget CRUD', () => {
  it('adds a widget, updates its layout and config independently, then removes it', async () => {
    const { dashboardId } = await seedDashboard()
    const cookie = await createAuthCookie(db, redis)

    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/widgets',
      headers: { cookie },
      payload: { dashboardId, widgetType: 'new_issues', title: 'Custom New Issues', layout: { x: 0, y: 8, w: 4, h: 3 } },
    })
    expect(createResponse.statusCode).toBe(201)
    const widgetId = createResponse.json().id

    const layoutResponse = await app.inject({
      method: 'PATCH',
      url: `/api/v1/widgets/${widgetId}/layout`,
      headers: { cookie },
      payload: { x: 2, y: 10, w: 5, h: 3 },
    })
    expect(layoutResponse.statusCode).toBe(200)

    const configResponse = await app.inject({
      method: 'PATCH',
      url: `/api/v1/widgets/${widgetId}/config`,
      headers: { cookie },
      payload: { windowDays: 30 },
    })
    expect(configResponse.statusCode).toBe(200)

    const stored = await db.selectFrom('dashboard_widget').selectAll().where('id', '=', widgetId).executeTakeFirstOrThrow()
    expect(stored.layout).toEqual({ x: 2, y: 10, w: 5, h: 3 })
    expect(stored.config).toEqual({ windowDays: 30 })

    const deleteResponse = await app.inject({ method: 'DELETE', url: `/api/v1/widgets/${widgetId}`, headers: { cookie } })
    expect(deleteResponse.statusCode).toBe(204)

    const gone = await db.selectFrom('dashboard_widget').selectAll().where('id', '=', widgetId).executeTakeFirst()
    expect(gone).toBeUndefined()
  })

  it("rejects a config PATCH that fails the widget type's own validation", async () => {
    const { dashboardId } = await seedDashboard()
    const cookie = await createAuthCookie(db, redis)
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/widgets',
      headers: { cookie },
      payload: { dashboardId, widgetType: 'top_issues', title: 'Bad Config Test', layout: { x: 0, y: 0, w: 4, h: 3 } },
    })
    const widgetId = created.json().id

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/widgets/${widgetId}/config`,
      headers: { cookie },
      payload: { limit: 9999 },
    })
    expect(response.statusCode).toBe(400)
  })

  it('returns 401 without a session', async () => {
    const { dashboardId } = await seedDashboard()
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/widgets',
      payload: { dashboardId, widgetType: 'new_issues', title: 'No Session', layout: { x: 0, y: 0, w: 4, h: 3 } },
    })
    expect(response.statusCode).toBe(401)
  })
})
