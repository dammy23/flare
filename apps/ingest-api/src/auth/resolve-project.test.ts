import { createDb } from '@flare/db'
import Redis from 'ioredis'
import { afterAll, describe, expect, it } from 'vitest'
import { resolveProjectByPublicKey } from './resolve-project'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379')

afterAll(async () => {
  await db.destroy()
  redis.disconnect()
})

describe('resolveProjectByPublicKey', () => {
  it('returns null for an unknown key', async () => {
    const result = await resolveProjectByPublicKey('does-not-exist', { db, redis })
    expect(result).toBeNull()
  })

  it('resolves a project from Postgres and caches it in Redis', async () => {
    const publicKey = `pk-resolve-${Date.now()}`
    const inserted = await db
      .insertInto('project')
      .values({ name: 'Resolve Test', slug: `resolve-test-${Date.now()}`, public_key: publicKey })
      .returningAll()
      .executeTakeFirstOrThrow()

    const first = await resolveProjectByPublicKey(publicKey, { db, redis })
    expect(first?.id).toBe(inserted.id)

    const cached = await redis.get(`dsn:${publicKey}`)
    expect(cached).not.toBeNull()

    const second = await resolveProjectByPublicKey(publicKey, { db, redis })
    expect(second?.id).toBe(inserted.id)
  })
})
