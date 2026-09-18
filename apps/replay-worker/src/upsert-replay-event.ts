import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { Database } from '@flare/db'

export async function upsertReplayEvent(
  db: Kysely<Database>,
  params: { projectId: string; environmentId: string; sessionId: string; errorCount: number }
): Promise<string> {
  const row = await db
    .insertInto('replay')
    .values({
      project_id: params.projectId,
      environment_id: params.environmentId,
      session_id: params.sessionId,
      error_count: params.errorCount,
    })
    .onConflict((oc) =>
      oc
        .columns(['project_id', 'session_id'])
        .doUpdateSet({ error_count: sql`replay.error_count + ${params.errorCount}` })
    )
    .returning('id')
    .executeTakeFirstOrThrow()

  return row.id
}
