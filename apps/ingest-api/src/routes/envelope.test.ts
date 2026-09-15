import { createDb } from '@flare/db'
import { Kafka } from 'kafkajs'
import Redis from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../app'
import { createKafkaProducer } from '../kafka/producer'

const brokers = [process.env.KAFKA_BROKERS ?? 'localhost:9092']
const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379')
const producer = createKafkaProducer(brokers)
const app = buildApp({ db, redis, producer, storage: {} as never })

let publicKey: string
let projectId: string

beforeAll(async () => {
  await producer.connect()
  publicKey = `pk-envelope-${Date.now()}`
  const inserted = await db
    .insertInto('project')
    .values({ name: 'Envelope Test', slug: `envelope-test-${Date.now()}`, public_key: publicKey })
    .returningAll()
    .executeTakeFirstOrThrow()
  projectId = inserted.id
})

afterAll(async () => {
  await producer.disconnect()
  await db.destroy()
  redis.disconnect()
  await app.close()
})

function envelopeBuffer(eventId: string): Buffer {
  const payload = JSON.stringify({
    event_id: eventId,
    environment: 'production',
    exception: { values: [{ type: 'Error', value: 'boom' }] },
  })
  const lines = [
    JSON.stringify({ event_id: eventId }),
    JSON.stringify({ type: 'event', length: Buffer.byteLength(payload) }),
    payload,
  ]
  return Buffer.from(lines.join('\n') + '\n')
}

describe('POST /api/:projectId/envelope/', () => {
  it('publishes an event item to Kafka and returns 200', async () => {
    const kafka = new Kafka({ clientId: 'test-consumer', brokers })
    const consumer = kafka.consumer({ groupId: `envelope-test-${Date.now()}` })
    await consumer.connect()
    await consumer.subscribe({ topic: 'ingest.errors', fromBeginning: true })

    const received: string[] = []
    const consumePromise = new Promise<void>((resolve) => {
      consumer.run({
        eachMessage: async ({ message }) => {
          received.push(message.value?.toString('utf8') ?? '')
          resolve()
        },
      })
    })

    const eventId = `event-${Date.now()}`
    const response = await app.inject({
      method: 'POST',
      url: `/api/${projectId}/envelope/`,
      headers: {
        'x-sentry-auth': `Sentry sentry_version=7, sentry_key=${publicKey}`,
        'content-type': 'application/x-sentry-envelope',
      },
      payload: envelopeBuffer(eventId),
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ id: eventId })

    await consumePromise
    await consumer.disconnect()

    expect(JSON.parse(received[0]).event_id).toBe(eventId)
  })

  it('returns 401 when the public key is unknown', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/${projectId}/envelope/`,
      headers: { 'x-sentry-auth': 'Sentry sentry_version=7, sentry_key=not-a-real-key' },
      payload: envelopeBuffer('irrelevant'),
    })
    expect(response.statusCode).toBe(401)
  })
})
