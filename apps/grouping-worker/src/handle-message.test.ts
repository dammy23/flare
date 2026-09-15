import { createDb } from '@flare/db'
import Redis from 'ioredis'
import { afterAll, describe, expect, it } from 'vitest'
import { handleErrorMessage } from './handle-message'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379')

afterAll(async () => {
  await db.destroy()
  redis.disconnect()
})

describe('handleErrorMessage', () => {
  it('resolves the environment, groups, and persists the event from a raw Kafka message', async () => {
    const project = await db
      .insertInto('project')
      .values({ name: 'Handle Msg Test', slug: `handle-msg-${Date.now()}`, public_key: `pk-handle-${Date.now()}` })
      .returningAll()
      .executeTakeFirstOrThrow()

    const rawMessage = Buffer.from(
      JSON.stringify({
        projectId: project.id,
        event: {
          event_id: `evt-handle-${Date.now()}`,
          environment: 'staging',
          exception: { values: [{ type: 'TypeError', value: 'boom', stacktrace: { frames: [{ filename: 'app.js', function: 'main', in_app: true }] } }] },
        },
      })
    )

    await handleErrorMessage(db, redis, rawMessage)

    const environment = await db
      .selectFrom('environment')
      .selectAll()
      .where('project_id', '=', project.id)
      .where('name', '=', 'staging')
      .executeTakeFirstOrThrow()

    const issues = await db.selectFrom('issue').selectAll().where('project_id', '=', project.id).execute()
    expect(issues).toHaveLength(1)
    expect(issues[0].title).toContain('TypeError')

    const issueEnv = await db
      .selectFrom('issue_environment')
      .selectAll()
      .where('issue_id', '=', issues[0].id)
      .where('environment_id', '=', environment.id)
      .executeTakeFirstOrThrow()
    expect(issueEnv.times_seen).toBe(1)
  })
})
