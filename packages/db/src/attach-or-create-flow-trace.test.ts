import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDb } from './create-db'
import { attachOrCreateFlowTrace } from './attach-or-create-flow-trace'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')

afterAll(() => db.destroy())

async function seedProject() {
  return db
    .insertInto('project')
    .values({ name: 'Flow Test', slug: `flow-test-${Date.now()}`, public_key: `pk-flow-${Date.now()}` })
    .returningAll()
    .executeTakeFirstOrThrow()
}

describe('attachOrCreateFlowTrace', () => {
  it('creates a new trace and registers the alias for a first-ever entity', async () => {
    const project = await seedProject()
    const entityId = `WO-${Date.now()}`

    const flowTraceId = await attachOrCreateFlowTrace(db, {
      projectId: project.id,
      reportedIds: [{ system: 'CRM', entityId }],
    })

    const alias = await db
      .selectFrom('flow_alias')
      .selectAll()
      .where('system', '=', 'CRM')
      .where('entity_id', '=', entityId)
      .executeTakeFirstOrThrow()
    expect(alias.flow_trace_id).toBe(flowTraceId)
  })

  it('attaches to the existing trace when a known id is reported, and registers a new translated id', async () => {
    const project = await seedProject()
    const woId = `WO-${Date.now()}`
    const masterId = `MASTER-${Date.now()}`

    const firstTraceId = await attachOrCreateFlowTrace(db, {
      projectId: project.id,
      reportedIds: [{ system: 'CRM', entityId: woId }],
    })

    const secondTraceId = await attachOrCreateFlowTrace(db, {
      projectId: project.id,
      reportedIds: [
        { system: 'CRM', entityId: woId },
        { system: 'MasterData', entityId: masterId },
      ],
    })

    expect(secondTraceId).toBe(firstTraceId)

    const masterAlias = await db
      .selectFrom('flow_alias')
      .selectAll()
      .where('system', '=', 'MasterData')
      .where('entity_id', '=', masterId)
      .executeTakeFirstOrThrow()
    expect(masterAlias.flow_trace_id).toBe(firstTraceId)
  })

  it('resolves a concurrent race for the same brand-new entity to a single trace', async () => {
    const project = await seedProject()
    const entityId = `WO-${Date.now()}`

    const [a, b] = await Promise.all([
      attachOrCreateFlowTrace(db, { projectId: project.id, reportedIds: [{ system: 'CRM', entityId }] }),
      attachOrCreateFlowTrace(db, { projectId: project.id, reportedIds: [{ system: 'CRM', entityId }] }),
    ])

    expect(a).toBe(b)

    const aliases = await db
      .selectFrom('flow_alias')
      .selectAll()
      .where('system', '=', 'CRM')
      .where('entity_id', '=', entityId)
      .execute()
    expect(aliases).toHaveLength(1)
  })

  describe('identity conflicts', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    })

    afterEach(() => {
      warnSpy.mockRestore()
    })

    it('does not silently merge two independently-established traces, and logs a warning', async () => {
      const project = await seedProject()
      const idA = `A-${Date.now()}`
      const idB = `B-${Date.now()}`

      const traceA = await attachOrCreateFlowTrace(db, {
        projectId: project.id,
        reportedIds: [{ system: 'SysA', entityId: idA }],
      })
      const traceB = await attachOrCreateFlowTrace(db, {
        projectId: project.id,
        reportedIds: [{ system: 'SysB', entityId: idB }],
      })
      expect(traceA).not.toBe(traceB)

      const resolved = await attachOrCreateFlowTrace(db, {
        projectId: project.id,
        reportedIds: [
          { system: 'SysA', entityId: idA },
          { system: 'SysB', entityId: idB },
        ],
      })

      expect(resolved).toBe(traceA)
      expect(warnSpy).toHaveBeenCalledTimes(1)
    })
  })
})
