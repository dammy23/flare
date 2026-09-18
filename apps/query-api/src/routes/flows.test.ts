import { createDb, attachOrCreateFlowTrace, upsertFlowStep } from '@flare/db'
import Redis from 'ioredis'
import { afterAll, describe, expect, it } from 'vitest'
import { buildApp } from '../app'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')
const queueConnection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
  lazyConnect: true,
})
const app = buildApp({ db, redis: {} as never, storage: {} as never, queueConnection })

afterAll(async () => {
  await db.destroy()
  queueConnection.disconnect()
  await app.close()
})

describe('GET /api/v1/flows/:flowTraceId', () => {
  it('returns the trace and its ordered steps', async () => {
    const project = await db
      .insertInto('project')
      .values({ name: 'Flow Route Test', slug: `flow-route-${Date.now()}`, public_key: `pk-flow-route-${Date.now()}` })
      .returningAll()
      .executeTakeFirstOrThrow()

    const entityId = `WO-${Date.now()}`
    const flowTraceId = await attachOrCreateFlowTrace(db, {
      projectId: project.id,
      reportedIds: [{ system: 'Dynamics', entityId }],
    })
    await upsertFlowStep(db, {
      flowTraceId,
      stageName: 'received',
      system: 'Dynamics',
      dedupKey: `dedup-route-${Date.now()}`,
      reportedIds: [{ system: 'Dynamics', entityId }],
      techTraceId: null,
      issueId: null,
      occurredAt: new Date(),
      status: 'ok',
    })

    const response = await app.inject({ method: 'GET', url: `/api/v1/flows/${flowTraceId}` })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.trace.id).toBe(flowTraceId)
    expect(body.steps).toHaveLength(1)
    expect(body.steps[0].stage_name).toBe('received')
  })

  it('returns 404 for an unknown flow trace', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/flows/00000000-0000-0000-0000-000000000000',
    })
    expect(response.statusCode).toBe(404)
  })
})
