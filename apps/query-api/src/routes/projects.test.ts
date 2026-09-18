import { createDb } from '@flare/db'
import { afterAll, describe, expect, it } from 'vitest'
import { buildApp } from '../app'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')
const app = buildApp({ db, redis: {} as never, storage: {} as never })

afterAll(async () => {
  await db.destroy()
  await app.close()
})

describe('POST /api/v1/projects', () => {
  it('creates a project with a generated public key and an auto-provisioned dashboard', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
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
    expect(widgets).toHaveLength(5)
  })

  it('rejects a duplicate slug', async () => {
    const slug = `dup-${Date.now()}`
    await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: 'A', slug } })
    const response = await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: 'B', slug } })
    expect(response.statusCode).toBe(409)
  })
})
