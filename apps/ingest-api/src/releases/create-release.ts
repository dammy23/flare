import type { Kysely } from 'kysely'
import type { Database } from '@flare/db'
import { resolveOrCreateRelease } from '@flare/db'
import type { Redis } from 'ioredis'

export async function createRelease(
  db: Kysely<Database>,
  redis: Redis,
  projectId: string,
  version: string
): Promise<{ version: string }> {
  await resolveOrCreateRelease(db, redis, projectId, version)
  return { version }
}
