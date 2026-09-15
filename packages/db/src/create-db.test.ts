import { execSync } from 'node:child_process'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb } from './create-db'
import type { Database } from './schema'
import type { Kysely } from 'kysely'

const connectionString =
  process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare'

let db: Kysely<Database>

beforeAll(() => {
  execSync('pnpm migrate:up', {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: connectionString },
    stdio: 'inherit',
  })
  db = createDb(connectionString)
})

afterAll(async () => {
  await db.destroy()
})

describe('createDb', () => {
  it('inserts and reads back a project row', async () => {
    const inserted = await db
      .insertInto('project')
      .values({ name: 'Test App', slug: `test-app-${Date.now()}`, public_key: `pk-${Date.now()}` })
      .returningAll()
      .executeTakeFirstOrThrow()

    const found = await db
      .selectFrom('project')
      .selectAll()
      .where('id', '=', inserted.id)
      .executeTakeFirstOrThrow()

    expect(found.name).toBe('Test App')
  })
})
