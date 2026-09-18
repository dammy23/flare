import { createDb, attachOrCreateFlowTrace, upsertFlowStep } from '@flare/db'
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
      reportedIds: [{ system: 'CRM', entityId }],
    })
    await upsertFlowStep(db, {
      flowTraceId,
      stageName: 'received',
      system: 'CRM',
      dedupKey: `dedup-route-${Date.now()}`,
      reportedIds: [{ system: 'CRM', entityId }],
      techTraceId: null,
      issueId: null,
      occurredAt: new Date(),
      status: 'ok',
    })
    const cookie = await createAuthCookie(db, redis)

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/flows/${flowTraceId}?projectId=${project.id}`,
      headers: { cookie },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.trace.id).toBe(flowTraceId)
    expect(body.steps).toHaveLength(1)
    expect(body.steps[0].stage_name).toBe('received')
    expect(body.deviations).toBeNull()

    const otherProject = await db
      .insertInto('project')
      .values({ name: 'Other Flow Project', slug: `other-flow-${Date.now()}`, public_key: `pk-other-flow-${Date.now()}` })
      .returningAll()
      .executeTakeFirstOrThrow()
    const crossProjectResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/flows/${flowTraceId}?projectId=${otherProject.id}`,
      headers: { cookie },
    })
    expect(crossProjectResponse.statusCode).toBe(404)
  })

  it('returns 404 for an unknown flow trace', async () => {
    const project = await db
      .insertInto('project')
      .values({ name: 'Unknown Flow Test', slug: `unknown-flow-${Date.now()}`, public_key: `pk-unknown-flow-${Date.now()}` })
      .returningAll()
      .executeTakeFirstOrThrow()
    const cookie = await createAuthCookie(db, redis)
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/flows/00000000-0000-0000-0000-000000000000?projectId=${project.id}`,
      headers: { cookie },
    })
    expect(response.statusCode).toBe(404)
  })

  it('returns 404 when projectId is missing but a session exists', async () => {
    const cookie = await createAuthCookie(db, redis)
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/flows/00000000-0000-0000-0000-000000000000',
      headers: { cookie },
    })
    expect(response.statusCode).toBe(404)
  })

  it('returns 401 without a session', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/flows/00000000-0000-0000-0000-000000000000',
    })
    expect(response.statusCode).toBe(401)
  })
})

describe('GET /api/v1/flows/board', () => {
  it('groups in_progress traces by current_stage', async () => {
    const project = await db
      .insertInto('project')
      .values({ name: 'Flow Board Test', slug: `flow-board-${Date.now()}`, public_key: `pk-flow-board-${Date.now()}` })
      .returningAll()
      .executeTakeFirstOrThrow()

    const entityId = `WO-board-${Date.now()}`
    const flowTraceId = await attachOrCreateFlowTrace(db, { projectId: project.id, reportedIds: [{ system: 'CRM', entityId }] })
    await upsertFlowStep(db, {
      flowTraceId,
      stageName: 'received',
      system: 'CRM',
      dedupKey: `dedup-board-${Date.now()}`,
      reportedIds: [],
      techTraceId: null,
      issueId: null,
      occurredAt: new Date(),
      status: 'ok',
    })
    const cookie = await createAuthCookie(db, redis)

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/flows/board?projectId=${project.id}`,
      headers: { cookie },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json() as Array<{ stage: string; traces: { id: string }[] }>
    const receivedGroup = body.find((g) => g.stage === 'received')
    expect(receivedGroup?.traces.some((t) => t.id === flowTraceId)).toBe(true)
  })

  it('returns 401 without a session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/flows/board?projectId=irrelevant' })
    expect(response.statusCode).toBe(401)
  })
})

describe('GET /api/v1/flows/map', () => {
  it('returns an edge with a count and average duration for a two-step trace', async () => {
    const project = await db
      .insertInto('project')
      .values({ name: 'Flow Map Test', slug: `flow-map-${Date.now()}`, public_key: `pk-flow-map-${Date.now()}` })
      .returningAll()
      .executeTakeFirstOrThrow()

    const entityId = `WO-map-${Date.now()}`
    const flowTraceId = await attachOrCreateFlowTrace(db, { projectId: project.id, reportedIds: [{ system: 'CRM', entityId }] })
    const start = new Date()
    await upsertFlowStep(db, {
      flowTraceId,
      stageName: 'received',
      system: 'CRM',
      dedupKey: `dedup-map-received-${Date.now()}`,
      reportedIds: [],
      techTraceId: null,
      issueId: null,
      occurredAt: start,
      status: 'ok',
    })
    await upsertFlowStep(db, {
      flowTraceId,
      stageName: 'mastered',
      system: 'MasterData',
      dedupKey: `dedup-map-mastered-${Date.now()}`,
      reportedIds: [],
      techTraceId: null,
      issueId: null,
      occurredAt: new Date(start.getTime() + 60_000),
      status: 'ok',
    })
    const cookie = await createAuthCookie(db, redis)

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/flows/map?projectId=${project.id}`,
      headers: { cookie },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json() as Array<{ from: string; to: string; count: number; avgDurationMs: number | null }>
    const edge = body.find((e) => e.from === 'received' && e.to === 'mastered')
    expect(edge?.count).toBe(1)
    expect(edge?.avgDurationMs).toBe(60000)
  })

  it('returns 401 without a session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/flows/map?projectId=irrelevant' })
    expect(response.statusCode).toBe(401)
  })
})
