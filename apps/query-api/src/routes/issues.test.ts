import { createDb } from '@flare/db'
import { afterAll, describe, expect, it } from 'vitest'
import { buildApp } from '../app'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')
const app = buildApp({ db, redis: {} as never })

afterAll(async () => {
  await db.destroy()
  await app.close()
})

async function seedIssueWithEvent() {
  const project = await db
    .insertInto('project')
    .values({ name: 'Query Test', slug: `query-test-${Date.now()}`, public_key: `pk-query-${Date.now()}` })
    .returningAll()
    .executeTakeFirstOrThrow()
  const environment = await db
    .insertInto('environment')
    .values({ project_id: project.id, name: 'production' })
    .returningAll()
    .executeTakeFirstOrThrow()
  const issue = await db
    .insertInto('issue')
    .values({
      project_id: project.id,
      fingerprint: `fp-query-${Date.now()}`,
      title: 'TypeError: boom',
      culprit: 'main in app.js',
      grouping_raw_components: '{}',
    })
    .returningAll()
    .executeTakeFirstOrThrow()
  await db
    .insertInto('event')
    .values({
      project_id: project.id,
      issue_id: issue.id,
      environment_id: environment.id,
      event_id: `evt-query-${Date.now()}`,
      timestamp: new Date(),
      message: 'boom',
      exception: '{}',
    })
    .execute()
  return { project, issue }
}

describe('GET /api/v1/projects/:projectId/issues', () => {
  it('lists issues for the project', async () => {
    const { project, issue } = await seedIssueWithEvent()

    const response = await app.inject({ method: 'GET', url: `/api/v1/projects/${project.id}/issues` })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.some((row: { id: string }) => row.id === issue.id)).toBe(true)
  })
})

describe('GET /api/v1/issues/:issueId', () => {
  it('returns issue detail with its events', async () => {
    const { issue } = await seedIssueWithEvent()

    const response = await app.inject({ method: 'GET', url: `/api/v1/issues/${issue.id}` })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.id).toBe(issue.id)
    expect(body.events.length).toBeGreaterThan(0)
  })

  it('returns 404 for an unknown issue', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/issues/00000000-0000-0000-0000-000000000000' })
    expect(response.statusCode).toBe(404)
  })
})
