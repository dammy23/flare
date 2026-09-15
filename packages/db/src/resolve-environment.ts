import type { Kysely } from 'kysely'
import type { Redis } from 'ioredis'
import type { Database } from './schema'

const CACHE_TTL_SECONDS = 300

export async function resolveEnvironment(
  db: Kysely<Database>,
  redis: Redis,
  projectId: string,
  name: string
): Promise<string> {
  const cacheKey = `env:${projectId}:${name}`
  const cached = await redis.get(cacheKey)
  if (cached) return cached

  const inserted = await db
    .insertInto('environment')
    .values({ project_id: projectId, name })
    .onConflict((oc) => oc.columns(['project_id', 'name']).doNothing())
    .returning('id')
    .executeTakeFirst()

  const id =
    inserted?.id ??
    (
      await db
        .selectFrom('environment')
        .select('id')
        .where('project_id', '=', projectId)
        .where('name', '=', name)
        .executeTakeFirstOrThrow()
    ).id

  await redis.set(cacheKey, id, 'EX', CACHE_TTL_SECONDS)
  return id
}
