import type { Kysely } from 'kysely'
import type { Database } from './schema'

export interface FlowDeviations {
  expectedStages: string[]
  observedStages: string[]
  skippedStages: string[]
  unexpectedStages: string[]
}

/**
 * Compares a trace's actually-observed stage sequence against its
 * flow_definition's expected order. Returns null when the trace has no
 * flow_definition_id -- there is nothing to compare against, which is the
 * normal case for every trace created via the checkpoint API today, not
 * an error. Looping/repeat-visit detection is a separate, out-of-scope
 * signal from "wrong order" -- only skipped and unexpected stages are
 * detected here.
 */
export async function detectFlowDeviations(db: Kysely<Database>, flowTraceId: string): Promise<FlowDeviations | null> {
  const trace = await db
    .selectFrom('flow_trace')
    .select('flow_definition_id')
    .where('id', '=', flowTraceId)
    .executeTakeFirst()

  if (!trace?.flow_definition_id) return null

  const expectedRows = await db
    .selectFrom('flow_step_definition')
    .select('stage_name')
    .where('flow_definition_id', '=', trace.flow_definition_id)
    .orderBy('sequence_order', 'asc')
    .execute()
  const expectedStages = expectedRows.map((row) => row.stage_name)

  const stepRows = await db
    .selectFrom('flow_step')
    .select('stage_name')
    .where('flow_trace_id', '=', flowTraceId)
    .orderBy('occurred_at', 'asc')
    .execute()

  const observedStages: string[] = []
  for (const row of stepRows) {
    if (!observedStages.includes(row.stage_name)) observedStages.push(row.stage_name)
  }

  return {
    expectedStages,
    observedStages,
    skippedStages: expectedStages.filter((stage) => !observedStages.includes(stage)),
    unexpectedStages: observedStages.filter((stage) => !expectedStages.includes(stage)),
  }
}
