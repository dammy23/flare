import type { Kysely } from 'kysely'
import type { Database } from './schema'

export async function archiveRawEnvelope(
  db: Kysely<Database>,
  params: { projectId: string; eventId: string | null; rawBytes: Buffer }
): Promise<string> {
  const row = await db
    .insertInto('raw_envelope')
    .values({ project_id: params.projectId, event_id: params.eventId, raw_bytes: params.rawBytes })
    .returning('id')
    .executeTakeFirstOrThrow()
  return row.id
}
