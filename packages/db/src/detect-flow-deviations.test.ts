import { afterAll, describe, expect, it } from 'vitest'
import { createDb } from './create-db'
import { attachOrCreateFlowTrace } from './attach-or-create-flow-trace'
import { upsertFlowStep } from './upsert-flow-step'
import { detectFlowDeviations } from './detect-flow-deviations'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')

afterAll(() => db.destroy())

async function seedProjectAndDefinition() {
  const project = await db
    .insertInto('project')
    .values({ name: 'Deviation Test', slug: `deviation-test-${Date.now()}`, public_key: `pk-deviation-${Date.now()}` })
    .returningAll()
    .executeTakeFirstOrThrow()

  const definition = await db
    .insertInto('flow_definition')
    .values({ project_id: project.id, name: 'Workorder' })
    .returningAll()
    .executeTakeFirstOrThrow()

  await db
    .insertInto('flow_step_definition')
    .values([
      { flow_definition_id: definition.id, stage_name: 'received', sequence_order: 0 },
      { flow_definition_id: definition.id, stage_name: 'mastered', sequence_order: 1 },
      { flow_definition_id: definition.id, stage_name: 'shipped', sequence_order: 2 },
    ])
    .execute()

  return { project, definition }
}

async function seedTraceWithSteps(projectId: string, definitionId: string | null, stages: string[]) {
  const entityId = `WO-${Date.now()}-${Math.random()}`
  const flowTraceId = await attachOrCreateFlowTrace(db, { projectId, reportedIds: [{ system: 'CRM', entityId }] })
  if (definitionId) {
    await db.updateTable('flow_trace').set({ flow_definition_id: definitionId }).where('id', '=', flowTraceId).execute()
  }
  let occurredAt = Date.now()
  for (const stage of stages) {
    await upsertFlowStep(db, {
      flowTraceId,
      stageName: stage,
      system: 'CRM',
      dedupKey: `dedup-deviation-${entityId}-${stage}`,
      reportedIds: [],
      techTraceId: null,
      issueId: null,
      occurredAt: new Date(occurredAt),
      status: 'ok',
    })
    occurredAt += 1000
  }
  return flowTraceId
}

describe('detectFlowDeviations', () => {
  it('returns null for a trace with no flow_definition_id', async () => {
    const { project } = await seedProjectAndDefinition()
    const flowTraceId = await seedTraceWithSteps(project.id, null, ['received'])
    expect(await detectFlowDeviations(db, flowTraceId)).toBeNull()
  })

  it('reports no deviations when every expected stage was observed', async () => {
    const { project, definition } = await seedProjectAndDefinition()
    const flowTraceId = await seedTraceWithSteps(project.id, definition.id, ['received', 'mastered', 'shipped'])

    const result = await detectFlowDeviations(db, flowTraceId)
    expect(result?.skippedStages).toEqual([])
    expect(result?.unexpectedStages).toEqual([])
  })

  it('reports a skipped stage when the definition expects a stage never observed', async () => {
    const { project, definition } = await seedProjectAndDefinition()
    const flowTraceId = await seedTraceWithSteps(project.id, definition.id, ['received', 'shipped'])

    const result = await detectFlowDeviations(db, flowTraceId)
    expect(result?.skippedStages).toEqual(['mastered'])
  })

  it('reports an unexpected stage when a step is observed outside the definition', async () => {
    const { project, definition } = await seedProjectAndDefinition()
    const flowTraceId = await seedTraceWithSteps(project.id, definition.id, ['received', 'rerouted', 'mastered', 'shipped'])

    const result = await detectFlowDeviations(db, flowTraceId)
    expect(result?.unexpectedStages).toEqual(['rerouted'])
  })
})
