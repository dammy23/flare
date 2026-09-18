import type { Kysely } from 'kysely'
import type { Database } from '@flare/db'
import type { Redis } from 'ioredis'
import type { StorageClient } from '@flare/storage'
import { resolveFrames } from './resolve-frames'
import { persistResolvedEvent } from './persist-resolved-event'

interface SymbolicationMessage {
  projectId: string
  eventId: string
  releaseId: string
  exception: Parameters<typeof resolveFrames>[0]
}

export async function handleSymbolicationMessage(
  deps: { db: Kysely<Database>; redis: Redis; storage: StorageClient },
  data: unknown
): Promise<void> {
  const message = data as SymbolicationMessage

  const cache = {
    get: (key: string) => deps.redis.get(key),
    set: (key: string, value: string) => deps.redis.set(key, value, 'EX', 86400).then(() => undefined),
  }

  const lookupArtifact = async (filename: string) => {
    const row = await deps.db
      .selectFrom('source_map_artifact')
      .select('storage_key')
      .where('release_id', '=', message.releaseId)
      .where('file_path', '=', `${filename}.map`)
      .executeTakeFirst()
    return row ? { storageKey: row.storage_key } : null
  }

  const resolved = await resolveFrames(message.exception, {
    storage: deps.storage,
    lookupArtifact,
    cache,
    releaseId: message.releaseId,
  })

  await persistResolvedEvent(deps.db, message.eventId, resolved)
}
