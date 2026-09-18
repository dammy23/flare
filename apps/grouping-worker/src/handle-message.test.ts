import { createDb } from '@flare/db'
import { Worker } from 'bullmq'
import Redis from 'ioredis'
import { afterAll, describe, expect, it } from 'vitest'
import { handleErrorMessage } from './handle-message'
import { createQueueProducer } from './queue/producer'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379')
const queueConnection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null })
const producer = createQueueProducer(queueConnection)

afterAll(async () => {
  await producer.close()
  await db.destroy()
  redis.disconnect()
  queueConnection.disconnect()
})

describe('handleErrorMessage', () => {
  it('resolves the environment, groups, and persists the event from a job payload', async () => {
    const project = await db
      .insertInto('project')
      .values({ name: 'Handle Msg Test', slug: `handle-msg-${Date.now()}`, public_key: `pk-handle-${Date.now()}` })
      .returningAll()
      .executeTakeFirstOrThrow()

    const message = {
      projectId: project.id,
      event: {
        event_id: `evt-handle-${Date.now()}`,
        environment: 'staging',
        exception: { values: [{ type: 'TypeError', value: 'boom', stacktrace: { frames: [{ filename: 'app.js', function: 'main', in_app: true }] } }] },
      },
    }

    await handleErrorMessage(db, redis, producer, message)

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

  it('publishes to work.symbolication when the event carries a release', async () => {
    const project = await db
      .insertInto('project')
      .values({ name: 'Symbolication Trigger Test', slug: `symtrigger-${Date.now()}`, public_key: `pk-symtrigger-${Date.now()}` })
      .returningAll()
      .executeTakeFirstOrThrow()

    let resolveData!: (data: unknown) => void
    const dataPromise = new Promise<unknown>((resolve) => {
      resolveData = resolve
    })
    const worker = new Worker(
      'work.symbolication',
      async (job) => {
        resolveData(job.data)
      },
      { connection: queueConnection }
    )

    const eventId = `evt-sym-${Date.now()}`
    const message = {
      projectId: project.id,
      event: {
        event_id: eventId,
        environment: 'production',
        release: '1.0.0-symtrigger',
        exception: { values: [{ type: 'TypeError', value: 'boom' }] },
      },
    }

    await handleErrorMessage(db, redis, producer, message)
    const published = (await dataPromise) as { projectId: string; eventId: string; releaseId: string }
    await worker.close()

    expect(published.projectId).toBe(project.id)
    expect(published.releaseId).toBeTruthy()

    const event = await db
      .selectFrom('event')
      .selectAll()
      .where('project_id', '=', project.id)
      .where('event_id', '=', eventId)
      .executeTakeFirstOrThrow()
    expect(event.release_id).toBe(published.releaseId)
    expect(event.id).toBe(published.eventId)
  })
})
