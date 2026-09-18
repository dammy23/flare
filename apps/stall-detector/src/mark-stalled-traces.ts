import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { Database } from '@flare/db'

/**
 * Marks in_progress traces as stalled when their current stage has been
 * active longer than that stage's expected_max_duration, per its
 * flow_definition. A single set-based UPDATE rather than a per-row loop --
 * this is meant to run on a schedule, not iterate application-side.
 * Traces with no flow_definition_id, or whose current stage has no
 * expected_max_duration configured, are left untouched (nothing to
 * compare against).
 */
export async function markStalledTraces(db: Kysely<Database>, now: Date = new Date()): Promise<number> {
  const result = await sql<{ id: string }>`
    UPDATE flow_trace
    SET status = 'stalled'
    WHERE status = 'in_progress'
      AND flow_definition_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM flow_step_definition
        WHERE flow_step_definition.flow_definition_id = flow_trace.flow_definition_id
          AND flow_step_definition.stage_name = flow_trace.current_stage
          AND flow_step_definition.expected_max_duration IS NOT NULL
          AND flow_trace.last_activity_at + flow_step_definition.expected_max_duration < ${now}
      )
    RETURNING id
  `.execute(db)

  return result.rows.length
}
