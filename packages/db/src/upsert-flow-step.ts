import type { Kysely } from 'kysely'
import type { Database } from './schema'

export interface UpsertFlowStepParams {
  flowTraceId: string
  stageName: string
  system: string
  dedupKey: string
  reportedIds: unknown
  techTraceId: string | null
  issueId: string | null
  occurredAt: Date
  status: 'ok' | 'error'
}

export async function upsertFlowStep(db: Kysely<Database>, params: UpsertFlowStepParams): Promise<void> {
  const inserted = await db
    .insertInto('flow_step')
    .values({
      flow_trace_id: params.flowTraceId,
      stage_name: params.stageName,
      system: params.system,
      dedup_key: params.dedupKey,
      reported_ids: JSON.stringify(params.reportedIds),
      tech_trace_id: params.techTraceId,
      issue_id: params.issueId,
      occurred_at: params.occurredAt,
      status: params.status,
    })
    .onConflict((oc) => oc.column('dedup_key').doNothing())
    .returning('id')
    .executeTakeFirst()

  if (!inserted) return

  // Out-of-order arrival: a late-arriving checkpoint with an earlier
  // occurred_at than the trace's current last_activity_at must still be
  // recorded (above) but must not regress the visible current stage.
  await db
    .updateTable('flow_trace')
    .set({ current_stage: params.stageName, last_activity_at: params.occurredAt })
    .where('id', '=', params.flowTraceId)
    .where('last_activity_at', '<=', params.occurredAt)
    .execute()
}
