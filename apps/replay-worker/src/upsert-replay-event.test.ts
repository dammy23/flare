import { createDb } from '@flare/db'
import { afterAll, describe, expect, it } from 'vitest'
import { upsertReplayEvent } from './upsert-replay-event'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')

afterAll(() => db.destroy())

describe('upsertReplayEvent', () => {
  it('creates the replay row on the first segment and increments error_count on a later one', async () => {
    const project = await db
      .insertInto('project')
      .values({ name: 'Replay Test', slug: `replay-test-${Date.now()}`, public_key: `pk-replay-${Date.now()}` })
      .returningAll()
      .executeTakeFirstOrThrow()
    const environment = await db
      .insertInto('environment')
      .values({ project_id: project.id, name: 'production' })
      .returningAll()
      .executeTakeFirstOrThrow()

    const sessionId = `session-${Date.now()}`
    await upsertReplayEvent(db, { projectId: project.id, environmentId: environment.id, sessionId, errorCount: 0 })
    await upsertReplayEvent(db, { projectId: project.id, environmentId: environment.id, sessionId, errorCount: 1 })

    const replay = await db.selectFrom('replay').selectAll().where('session_id', '=', sessionId).executeTakeFirstOrThrow()
    expect(replay.error_count).toBe(1)
  })
})
