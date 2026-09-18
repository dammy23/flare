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
    const cookie = await createAuthCookie(db, redis)

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${project.id}/issues`,
      headers: { cookie },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.some((row: { id: string }) => row.id === issue.id)).toBe(true)
  })

  it('returns 401 without a session', async () => {
    const { project } = await seedIssueWithEvent()
    const response = await app.inject({ method: 'GET', url: `/api/v1/projects/${project.id}/issues` })
    expect(response.statusCode).toBe(401)
  })
})

describe('GET /api/v1/issues/:issueId', () => {
  it('returns issue detail with its events when projectId matches', async () => {
    const { project, issue } = await seedIssueWithEvent()
    const cookie = await createAuthCookie(db, redis)

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/issues/${issue.id}?projectId=${project.id}`,
      headers: { cookie },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.id).toBe(issue.id)
    expect(body.events.length).toBeGreaterThan(0)
  })

  it('returns 404 for an unknown issue', async () => {
    const { project } = await seedIssueWithEvent()
    const cookie = await createAuthCookie(db, redis)
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/issues/00000000-0000-0000-0000-000000000000?projectId=${project.id}`,
      headers: { cookie },
    })
    expect(response.statusCode).toBe(404)
  })

  it('returns 404 when projectId does not match the issue (no cross-project leakage)', async () => {
    const { issue } = await seedIssueWithEvent()
    const cookie = await createAuthCookie(db, redis)
    const otherProject = await db
      .insertInto('project')
      .values({ name: 'Other Project', slug: `other-project-${Date.now()}`, public_key: `pk-other-${Date.now()}` })
      .returningAll()
      .executeTakeFirstOrThrow()

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/issues/${issue.id}?projectId=${otherProject.id}`,
      headers: { cookie },
    })
    expect(response.statusCode).toBe(404)
  })

  it('returns 404 when projectId is missing entirely (still requires a session)', async () => {
    const cookie = await createAuthCookie(db, redis)
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/issues/00000000-0000-0000-0000-000000000000',
      headers: { cookie },
    })
    expect(response.statusCode).toBe(404)
  })

  it('returns 401 without a session, before the projectId check ever runs', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/issues/00000000-0000-0000-0000-000000000000' })
    expect(response.statusCode).toBe(401)
  })
})
