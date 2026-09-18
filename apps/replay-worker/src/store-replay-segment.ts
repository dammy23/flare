import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { Database } from '@flare/db'
import type { StorageClient } from '@flare/storage'

export async function storeReplaySegment(
  deps: { db: Kysely<Database>; storage: StorageClient },
  params: { projectId: string; replayId: string; sequence: number; content: Buffer }
): Promise<void> {
  const storageKey = `replays/${params.projectId}/${params.replayId}/${params.sequence}.bin`
  await deps.storage.putObject(storageKey, params.content)

  // ON CONFLICT DO NOTHING returns no row on a duplicate (Kafka retry of
  // the same segment) -- segment_count must only increment for a genuine
  // first-time insert, or a retried message would double-count it. Same
  // idempotency shape as grouping-worker's event insert.
  const inserted = await deps.db
    .insertInto('replay_segment')
    .values({ replay_id: params.replayId, sequence: params.sequence, storage_key: storageKey, size_bytes: params.content.length })
    .onConflict((oc) => oc.columns(['replay_id', 'sequence']).doNothing())
    .returning('replay_id')
    .executeTakeFirst()

  if (inserted) {
    await deps.db
      .updateTable('replay')
      .set({ segment_count: sql`segment_count + 1` })
      .where('id', '=', params.replayId)
      .execute()
  }
}
