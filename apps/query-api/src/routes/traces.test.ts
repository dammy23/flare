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

describe('GET /api/v1/traces/:traceId', () => {
  it('returns the transaction and its spans for a trace', async () => {
    const project = await db
      .insertInto('project')
      .values({ name: 'Trace Test', slug: `trace-test-${Date.now()}`, public_key: `pk-trace-${Date.now()}` })
      .returningAll()
      .executeTakeFirstOrThrow()
    const environment = await db
      .insertInto('environment')
      .values({ project_id: project.id, name: 'production' })
      .returningAll()
      .executeTakeFirstOrThrow()
    const traceId = 'f'.repeat(32)
    const tx = await db
      .insertInto('transaction')
      .values({
        project_id: project.id,
        environment_id: environment.id,
        trace_id: traceId,
        name: 'GET /api/widgets',
        start_ts: new Date(),
        duration_ms: 120,
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    await db
      .insertInto('span')
      .values({ transaction_id: tx.id, trace_id: traceId, span_id: 'a'.repeat(16), start_ts: new Date(), duration_ms: 40 })
      .execute()
    const cookie = await createAuthCookie(db, redis)

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/traces/${traceId}?projectId=${project.id}`,
      headers: { cookie },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.transactions).toHaveLength(1)
    expect(body.spans).toHaveLength(1)
  })

  it('returns no transactions/spans for a different project (no cross-project leakage)', async () => {
    const project = await db
      .insertInto('project')
      .values({ name: 'Trace Test Owner', slug: `trace-owner-${Date.now()}`, public_key: `pk-trace-owner-${Date.now()}` })
      .returningAll()
      .executeTakeFirstOrThrow()
    const otherProject = await db
      .insertInto('project')
      .values({ name: 'Trace Test Other', slug: `trace-other-${Date.now()}`, public_key: `pk-trace-other-${Date.now()}` })
      .returningAll()
      .executeTakeFirstOrThrow()
    const environment = await db
      .insertInto('environment')
      .values({ project_id: project.id, name: 'production' })
      .returningAll()
      .executeTakeFirstOrThrow()
    const traceId = 'e'.repeat(32)
    await db
      .insertInto('transaction')
      .values({
        project_id: project.id,
        environment_id: environment.id,
        trace_id: traceId,
        name: 'GET /api/widgets',
        start_ts: new Date(),
        duration_ms: 120,
      })
      .execute()
    const cookie = await createAuthCookie(db, redis)

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/traces/${traceId}?projectId=${otherProject.id}`,
      headers: { cookie },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.transactions).toHaveLength(0)
    expect(body.spans).toHaveLength(0)
  })

  it('returns empty arrays when projectId is missing but a session exists', async () => {
    const cookie = await createAuthCookie(db, redis)
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/traces/${'f'.repeat(32)}`,
      headers: { cookie },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.transactions).toEqual([])
    expect(body.spans).toEqual([])
  })

  it('returns 401 without a session', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/v1/traces/${'f'.repeat(32)}` })
    expect(response.statusCode).toBe(401)
  })
})
