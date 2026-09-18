import { createDb, provisionDefaultDashboard } from '@flare/db'
import { afterAll, describe, expect, it } from 'vitest'
import { buildApp } from '../app'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')
const app = buildApp({ db, redis: {} as never, storage: {} as never })

afterAll(async () => {
  await db.destroy()
  await app.close()
})

describe('GET /api/v1/projects/:projectId/dashboard', () => {
  it('returns the provisioned dashboard with its four widgets', async () => {
    const project = await db
      .insertInto('project')
      .values({ name: 'Dashboard Fetch Test', slug: `dash-fetch-${Date.now()}`, public_key: `pk-dash-${Date.now()}` })
      .returningAll()
      .executeTakeFirstOrThrow()
    await provisionDefaultDashboard(db, project.id)

    const response = await app.inject({ method: 'GET', url: `/api/v1/projects/${project.id}/dashboard` })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.projectId).toBe(project.id)
    expect(body.widgets).toHaveLength(5)
  })

  it('returns 404 when the project has no dashboard', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/00000000-0000-0000-0000-000000000000/dashboard',
    })
    expect(response.statusCode).toBe(404)
  })
})
