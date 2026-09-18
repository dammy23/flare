import { createDb } from '@flare/db'
import { afterAll, describe, expect, it } from 'vitest'
import { handleFlowCheckpointMessage } from './handle-message'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')

afterAll(() => db.destroy())

async function seedProject() {
  return db
    .insertInto('project')
    .values({ name: 'Flow Handle Msg Test', slug: `flow-handle-${Date.now()}`, public_key: `pk-flow-handle-${Date.now()}` })
    .returningAll()
    .executeTakeFirstOrThrow()
}

describe('handleFlowCheckpointMessage', () => {
  it('creates a flow_trace and flow_step from a checkpoint job payload', async () => {
    const project = await seedProject()
    const entityId = `WO-${Date.now()}`

    await handleFlowCheckpointMessage(db, {
      projectId: project.id,
      checkpoint: {
        stage: 'received',
        system: 'CRM',
        entityIds: [{ system: 'CRM', entityId }],
        dedupKey: `crm:${entityId}:received`,
        occurredAt: new Date().toISOString(),
      },
    })

    const alias = await db
      .selectFrom('flow_alias')
      .selectAll()
      .where('system', '=', 'CRM')
      .where('entity_id', '=', entityId)
      .executeTakeFirstOrThrow()

    const trace = await db.selectFrom('flow_trace').selectAll().where('id', '=', alias.flow_trace_id).executeTakeFirstOrThrow()
    expect(trace.current_stage).toBe('received')

    const steps = await db.selectFrom('flow_step').selectAll().where('flow_trace_id', '=', trace.id).execute()
    expect(steps).toHaveLength(1)
    expect(steps[0].stage_name).toBe('received')
  })

  it('attaches a second checkpoint reporting a known id to the same trace', async () => {
    const project = await seedProject()
    const woId = `WO-${Date.now()}`
    const masterId = `MASTER-${Date.now()}`

    await handleFlowCheckpointMessage(db, {
      projectId: project.id,
      checkpoint: {
        stage: 'received',
        system: 'CRM',
        entityIds: [{ system: 'CRM', entityId: woId }],
        dedupKey: `crm:${woId}:received`,
        occurredAt: new Date().toISOString(),
      },
    })

    await handleFlowCheckpointMessage(db, {
      projectId: project.id,
      checkpoint: {
        stage: 'mastered',
        system: 'MasterData',
        entityIds: [
          { system: 'CRM', entityId: woId },
          { system: 'MasterData', entityId: masterId },
        ],
        dedupKey: `masterdata:${masterId}:mastered`,
        occurredAt: new Date().toISOString(),
      },
    })

    const crmAlias = await db
      .selectFrom('flow_alias')
      .selectAll()
      .where('system', '=', 'CRM')
      .where('entity_id', '=', woId)
      .executeTakeFirstOrThrow()

    const steps = await db
      .selectFrom('flow_step')
      .selectAll()
      .where('flow_trace_id', '=', crmAlias.flow_trace_id)
      .execute()
    expect(steps).toHaveLength(2)

    const trace = await db
      .selectFrom('flow_trace')
      .selectAll()
      .where('id', '=', crmAlias.flow_trace_id)
      .executeTakeFirstOrThrow()
    expect(trace.current_stage).toBe('mastered')
  })
})
