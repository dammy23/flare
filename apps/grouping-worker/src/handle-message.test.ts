import { createDb } from '@flare/db'
import { Kafka } from 'kafkajs'
import Redis from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { handleErrorMessage } from './handle-message'
import { createKafkaProducer } from './kafka/producer'

const brokers = [process.env.KAFKA_BROKERS ?? 'localhost:9092']
const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379')
const producer = createKafkaProducer(brokers)

beforeAll(() => producer.connect())

afterAll(async () => {
  await producer.disconnect()
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

    await handleErrorMessage(db, redis, producer, rawMessage)

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

    const kafka = new Kafka({ clientId: 'test-consumer', brokers })
    const consumer = kafka.consumer({ groupId: `symtrigger-test-${Date.now()}` })
    await consumer.connect()
    await consumer.subscribe({ topic: 'work.symbolication', fromBeginning: true })

    const received: string[] = []
    const consumePromise = new Promise<void>((resolve) => {
      consumer.run({
        eachMessage: async ({ message }) => {
          received.push(message.value?.toString('utf8') ?? '')
          resolve()
        },
      })
    })

    const eventId = `evt-sym-${Date.now()}`
    const rawMessage = Buffer.from(
      JSON.stringify({
        projectId: project.id,
        event: {
          event_id: eventId,
          environment: 'production',
          release: '1.0.0-symtrigger',
          exception: { values: [{ type: 'TypeError', value: 'boom' }] },
        },
      })
    )

    await handleErrorMessage(db, redis, producer, rawMessage)
    await consumePromise
    await consumer.disconnect()

    const message = JSON.parse(received[0]) as { projectId: string; eventId: string; releaseId: string }
    expect(message.projectId).toBe(project.id)
    expect(message.releaseId).toBeTruthy()

    const event = await db
      .selectFrom('event')
      .selectAll()
      .where('project_id', '=', project.id)
      .where('event_id', '=', eventId)
      .executeTakeFirstOrThrow()
    expect(event.release_id).toBe(message.releaseId)
    expect(event.id).toBe(message.eventId)
  })
})
