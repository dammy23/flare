import type { Kysely } from 'kysely'
import type { Database } from '@flare/db'
import { resolveOrCreateRelease } from '@flare/db'
import type { Redis } from 'ioredis'
import type { StorageClient } from '@flare/storage'

export async function uploadArtifact(
  deps: { db: Kysely<Database>; redis: Redis; storage: StorageClient },
  params: { projectId: string; version: string; fileName: string; content: Buffer; contentType?: string }
): Promise<{ storageKey: string }> {
  const releaseId = await resolveOrCreateRelease(deps.db, deps.redis, params.projectId, params.version)
  const sanitizedName = params.fileName.replace(/[^a-zA-Z0-9._-]/g, '_')
  const storageKey = `releases/${params.projectId}/${params.version}/${sanitizedName}`

  await deps.storage.putObject(storageKey, params.content, params.contentType)

  await deps.db
    .insertInto('source_map_artifact')
    .values({
      release_id: releaseId,
      file_path: params.fileName,
      storage_key: storageKey,
      content_type: params.contentType ?? null,
    })
    .onConflict((oc) => oc.columns(['release_id', 'file_path']).doUpdateSet({ storage_key: storageKey }))
    .execute()

  return { storageKey }
}
