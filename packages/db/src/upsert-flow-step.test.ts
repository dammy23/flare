import { afterAll, describe, expect, it } from 'vitest'
import { createDb } from './create-db'
import { attachOrCreateFlowTrace } from './attach-or-create-flow-trace'
import { upsertFlowStep } from './upsert-flow-step'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')

afterAll(() => db.destroy())

async function seedTrace() {
  const project = await db
    .insertInto('project')
    .values({ name: 'Flow Step Test', slug: `flow-step-test-${Date.now()}`, public_key: `pk-flow-step-${Date.now()}` })
    .returningAll()
    .executeTakeFirstOrThrow()
  const flowTraceId = await attachOrCreateFlowTrace(db, {
    projectId: project.id,
    reportedIds: [{ system: 'Dynamics', entityId: `WO-${Date.now()}` }],
  })
  return flowTraceId
}

describe('upsertFlowStep', () => {
  it('inserts the step and advances the trace current_stage', async () => {
    const flowTraceId = await seedTrace()
    const occurredAt = new Date()

    await upsertFlowStep(db, {
      flowTraceId,
      stageName: 'received',
      system: 'Dynamics',
      dedupKey: `dedup-${Date.now()}`,
      reportedIds: [],
      techTraceId: null,
      issueId: null,
      occurredAt,
      status: 'ok',
    })

    const trace = await db.selectFrom('flow_trace').selectAll().where('id', '=', flowTraceId).executeTakeFirstOrThrow()
    expect(trace.current_stage).toBe('received')
  })

  it('is a no-op on a retried dedupKey (does not duplicate the row or re-advance the stage)', async () => {
    const flowTraceId = await seedTrace()
    const dedupKey = `dedup-retry-${Date.now()}`
    const occurredAt = new Date()

    await upsertFlowStep(db, {
      flowTraceId,
      stageName: 'received',
      system: 'Dynamics',
      dedupKey,
      reportedIds: [],
      techTraceId: null,
      issueId: null,
      occurredAt,
      status: 'ok',
    })
    await upsertFlowStep(db, {
      flowTraceId,
      stageName: 'received',
      system: 'Dynamics',
      dedupKey,
      reportedIds: [],
      techTraceId: null,
      issueId: null,
      occurredAt,
      status: 'ok',
    })

    const steps = await db.selectFrom('flow_step').selectAll().where('dedup_key', '=', dedupKey).execute()
    expect(steps).toHaveLength(1)
  })

  it('records an out-of-order (earlier-timestamped) checkpoint without regressing current_stage', async () => {
    const flowTraceId = await seedTrace()
    const laterOccurredAt = new Date()
    const earlierOccurredAt = new Date(laterOccurredAt.getTime() - 60_000)

    await upsertFlowStep(db, {
      flowTraceId,
      stageName: 'shipped',
      system: 'AMS2',
      dedupKey: `dedup-later-${Date.now()}`,
      reportedIds: [],
      techTraceId: null,
      issueId: null,
      occurredAt: laterOccurredAt,
      status: 'ok',
    })

    await upsertFlowStep(db, {
      flowTraceId,
      stageName: 'received',
      system: 'Dynamics',
      dedupKey: `dedup-earlier-${Date.now()}`,
      reportedIds: [],
      techTraceId: null,
      issueId: null,
      occurredAt: earlierOccurredAt,
      status: 'ok',
    })

    const trace = await db.selectFrom('flow_trace').selectAll().where('id', '=', flowTraceId).executeTakeFirstOrThrow()
    expect(trace.current_stage).toBe('shipped')

    const steps = await db.selectFrom('flow_step').selectAll().where('flow_trace_id', '=', flowTraceId).execute()
    expect(steps).toHaveLength(2)
  })
})
