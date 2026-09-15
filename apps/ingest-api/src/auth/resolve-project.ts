import type { Kysely } from 'kysely'
import type { Database } from '@flare/db'
import type { Redis } from 'ioredis'

export interface Project {
  id: string
  name: string
  slug: string
  publicKey: string
}

const CACHE_TTL_SECONDS = 300

export async function resolveProjectByPublicKey(
  publicKey: string,
  deps: { db: Kysely<Database>; redis: Redis }
): Promise<Project | null> {
  const cacheKey = `dsn:${publicKey}`
  const cached = await deps.redis.get(cacheKey)
  if (cached) return JSON.parse(cached) as Project

  const row = await deps.db
    .selectFrom('project')
    .select(['id', 'name', 'slug', 'public_key'])
    .where('public_key', '=', publicKey)
    .executeTakeFirst()

  if (!row) return null

  const project: Project = { id: row.id, name: row.name, slug: row.slug, publicKey: row.public_key }
  await deps.redis.set(cacheKey, JSON.stringify(project), 'EX', CACHE_TTL_SECONDS)
  return project
}
