import Redis from 'ioredis'
import { afterAll, describe, expect, it } from 'vitest'
import { createDb } from './create-db'
import { resolveEnvironment } from './resolve-environment'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379')

afterAll(async () => {
  await db.destroy()
  redis.disconnect()
})

describe('resolveEnvironment', () => {
  it('creates the environment on first sighting and reuses it on the next call', async () => {
    const project = await db
      .insertInto('project')
      .values({ name: 'Env Test', slug: `env-test-${Date.now()}`, public_key: `pk-env-${Date.now()}` })
      .returningAll()
      .executeTakeFirstOrThrow()

    const firstId = await resolveEnvironment(db, redis, project.id, 'staging')
    const secondId = await resolveEnvironment(db, redis, project.id, 'staging')

    expect(firstId).toBe(secondId)

    const rows = await db
      .selectFrom('environment')
      .selectAll()
      .where('project_id', '=', project.id)
      .where('name', '=', 'staging')
      .execute()
    expect(rows).toHaveLength(1)
  })
})
