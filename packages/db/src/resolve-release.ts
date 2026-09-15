import type { Kysely } from 'kysely'
import type { Redis } from 'ioredis'
import type { Database } from './schema'

const CACHE_TTL_SECONDS = 300

export async function resolveOrCreateRelease(
  db: Kysely<Database>,
  redis: Redis,
  projectId: string,
  version: string
): Promise<string> {
  const cacheKey = `release:${projectId}:${version}`
  const cached = await redis.get(cacheKey)
  if (cached) return cached

  const inserted = await db
    .insertInto('release')
    .values({ project_id: projectId, version })
    .onConflict((oc) => oc.columns(['project_id', 'version']).doNothing())
    .returning('id')
    .executeTakeFirst()

  const id =
    inserted?.id ??
    (
      await db
        .selectFrom('release')
        .select('id')
        .where('project_id', '=', projectId)
        .where('version', '=', version)
        .executeTakeFirstOrThrow()
    ).id

  await redis.set(cacheKey, id, 'EX', CACHE_TTL_SECONDS)
  return id
}
