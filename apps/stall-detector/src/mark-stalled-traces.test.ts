import { createDb, attachOrCreateFlowTrace, upsertFlowStep } from '@flare/db'
import { afterAll, describe, expect, it } from 'vitest'
import { markStalledTraces } from './mark-stalled-traces'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')

afterAll(() => db.destroy())

async function seedProjectAndDefinition() {
  const project = await db
    .insertInto('project')
    .values({ name: 'Stall Test', slug: `stall-test-${Date.now()}`, public_key: `pk-stall-${Date.now()}` })
    .returningAll()
    .executeTakeFirstOrThrow()

  const definition = await db
    .insertInto('flow_definition')
    .values({ project_id: project.id, name: 'Workorder' })
    .returningAll()
    .executeTakeFirstOrThrow()

  await db
    .insertInto('flow_step_definition')
    .values({
      flow_definition_id: definition.id,
      stage_name: 'received',
      sequence_order: 0,
      expected_max_duration: '1 hour',
    })
    .execute()

  return { project, definition }
}

async function seedTraceAtStage(projectId: string, definitionId: string, stage: string, lastActivityAt: Date) {
  const entityId = `WO-${Date.now()}-${Math.random()}`
  const flowTraceId = await attachOrCreateFlowTrace(db, { projectId, reportedIds: [{ system: 'CRM', entityId }] })
  await upsertFlowStep(db, {
    flowTraceId,
    stageName: stage,
    system: 'CRM',
    dedupKey: `dedup-stall-${entityId}`,
    reportedIds: [],
    techTraceId: null,
    issueId: null,
    occurredAt: lastActivityAt,
    status: 'ok',
  })
  await db
    .updateTable('flow_trace')
    .set({ flow_definition_id: definitionId, last_activity_at: lastActivityAt })
    .where('id', '=', flowTraceId)
    .execute()
  return flowTraceId
}

describe('markStalledTraces', () => {
  it('marks a trace stalled when its current stage exceeded expected_max_duration', async () => {
    const { project, definition } = await seedProjectAndDefinition()
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
    const flowTraceId = await seedTraceAtStage(project.id, definition.id, 'received', twoHoursAgo)

    await markStalledTraces(db)

    const trace = await db.selectFrom('flow_trace').selectAll().where('id', '=', flowTraceId).executeTakeFirstOrThrow()
    expect(trace.status).toBe('stalled')
  })

  it('leaves a trace in_progress when within its expected_max_duration', async () => {
    const { project, definition } = await seedProjectAndDefinition()
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000)
    const flowTraceId = await seedTraceAtStage(project.id, definition.id, 'received', fiveMinutesAgo)

    await markStalledTraces(db)

    const trace = await db.selectFrom('flow_trace').selectAll().where('id', '=', flowTraceId).executeTakeFirstOrThrow()
    expect(trace.status).toBe('in_progress')
  })

  it('leaves a trace with no flow_definition_id untouched regardless of age', async () => {
    const { project } = await seedProjectAndDefinition()
    const entityId = `WO-nodef-${Date.now()}`
    const flowTraceId = await attachOrCreateFlowTrace(db, { projectId: project.id, reportedIds: [{ system: 'CRM', entityId }] })
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
    await upsertFlowStep(db, {
      flowTraceId,
      stageName: 'received',
      system: 'CRM',
      dedupKey: `dedup-nodef-${entityId}`,
      reportedIds: [],
      techTraceId: null,
      issueId: null,
      occurredAt: twoHoursAgo,
      status: 'ok',
    })
    await db.updateTable('flow_trace').set({ last_activity_at: twoHoursAgo }).where('id', '=', flowTraceId).execute()

    await markStalledTraces(db)

    const trace = await db.selectFrom('flow_trace').selectAll().where('id', '=', flowTraceId).executeTakeFirstOrThrow()
    expect(trace.status).toBe('in_progress')
  })
})
