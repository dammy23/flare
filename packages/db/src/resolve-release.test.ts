import Redis from 'ioredis'
import { afterAll, describe, expect, it } from 'vitest'
import { createDb } from './create-db'
import { resolveOrCreateRelease } from './resolve-release'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379')

afterAll(async () => {
  await db.destroy()
  redis.disconnect()
})

describe('resolveOrCreateRelease', () => {
  it('creates the release on first sighting and reuses it on the next call', async () => {
    const project = await db
      .insertInto('project')
      .values({ name: 'Release Test', slug: `release-test-${Date.now()}`, public_key: `pk-release-${Date.now()}` })
      .returningAll()
      .executeTakeFirstOrThrow()

    const firstId = await resolveOrCreateRelease(db, redis, project.id, '1.2.3')
    const secondId = await resolveOrCreateRelease(db, redis, project.id, '1.2.3')

    expect(firstId).toBe(secondId)

    const rows = await db
      .selectFrom('release')
      .selectAll()
      .where('project_id', '=', project.id)
      .where('version', '=', '1.2.3')
      .execute()
    expect(rows).toHaveLength(1)
  })
})
