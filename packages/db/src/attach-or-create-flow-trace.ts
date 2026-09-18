import type { Kysely } from 'kysely'
import type { Database } from './schema'

export interface FlowEntityId {
  system: string
  entityId: string
}

export async function attachOrCreateFlowTrace(
  db: Kysely<Database>,
  params: { projectId: string; reportedIds: FlowEntityId[] }
): Promise<string> {
  let flowTraceId: string | null = null
  for (const { system, entityId } of params.reportedIds) {
    const alias = await db
      .selectFrom('flow_alias')
      .select('flow_trace_id')
      .where('system', '=', system)
      .where('entity_id', '=', entityId)
      .executeTakeFirst()
    if (alias) {
      flowTraceId = alias.flow_trace_id
      break
    }
  }

  let createdNewTrace = false
  if (!flowTraceId) {
    const trace = await db
      .insertInto('flow_trace')
      .values({ project_id: params.projectId })
      .returning('id')
      .executeTakeFirstOrThrow()
    flowTraceId = trace.id
    createdNewTrace = true
  }

  for (const { system, entityId } of params.reportedIds) {
    const inserted = await db
      .insertInto('flow_alias')
      .values({ flow_trace_id: flowTraceId, system, entity_id: entityId })
      .onConflict((oc) => oc.columns(['system', 'entity_id']).doNothing())
      .returning('flow_trace_id')
      .executeTakeFirst()

    if (!inserted) {
      const existing = await db
        .selectFrom('flow_alias')
        .select('flow_trace_id')
        .where('system', '=', system)
        .where('entity_id', '=', entityId)
        .executeTakeFirstOrThrow()
      if (existing.flow_trace_id !== flowTraceId) {
        if (createdNewTrace) {
          // Lost the race to register this identity concurrently -- adopt
          // the winner's trace instead of leaving our own freshly-created
          // one as an orphan.
          flowTraceId = existing.flow_trace_id
          createdNewTrace = false
        } else {
          console.warn(
            `flow-stitch: identity conflict -- (${system}, ${entityId}) already aliased to ` +
              `flow_trace ${existing.flow_trace_id}, this checkpoint resolved to ${flowTraceId}. ` +
              `Not merging automatically; needs manual review.`
          )
        }
      }
    }
  }

  return flowTraceId
}
