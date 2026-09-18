import { createDb } from '@flare/db'
import { Worker } from 'bullmq'
import Redis from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../app'
import { createQueueProducer } from '../queue/producer'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379')
const queueConnection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null })
const producer = createQueueProducer(queueConnection)
const app = buildApp({ db, redis, producer, storage: {} as never })

let publicKey: string
let projectId: string

beforeAll(async () => {
  publicKey = `pk-envelope-${Date.now()}`
  const inserted = await db
    .insertInto('project')
    .values({ name: 'Envelope Test', slug: `envelope-test-${Date.now()}`, public_key: publicKey })
    .returningAll()
    .executeTakeFirstOrThrow()
  projectId = inserted.id
})

afterAll(async () => {
  await producer.close()
  await db.destroy()
  redis.disconnect()
  queueConnection.disconnect()
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

/** Runs a throwaway Worker for one job, resolving with its data -- the
 * BullMQ equivalent of the old "subscribe, then trigger, then assert on
 * what arrived" KafkaJS consumer pattern. */
function waitForOneJob(queueName: string): { data: Promise<unknown>; worker: Worker } {
  let resolveData!: (data: unknown) => void
  const data = new Promise<unknown>((resolve) => {
    resolveData = resolve
  })
  const worker = new Worker(
    queueName,
    async (job) => {
      resolveData(job.data)
    },
    { connection: queueConnection }
  )
  return { data, worker }
}

describe('POST /api/:projectId/envelope/', () => {
  it('publishes an event item to BullMQ and returns 200', async () => {
    const { data, worker } = waitForOneJob('ingest.errors')

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

    const received = (await data) as { event: { event_id: string } }
    await worker.close()

    expect(received.event.event_id).toBe(eventId)
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

  it('publishes a transaction item to ingest.transactions', async () => {
    const { data, worker } = waitForOneJob('ingest.transactions')

    const eventId = `tx-${Date.now()}`
    const payload = JSON.stringify({
      event_id: eventId,
      transaction: 'GET /api/widgets',
      start_timestamp: 1700000000,
      timestamp: 1700000000.2,
      contexts: { trace: { trace_id: 'a'.repeat(32), span_id: 'b'.repeat(16) } },
    })
    const raw = Buffer.from(
      [
        JSON.stringify({ event_id: eventId }),
        JSON.stringify({ type: 'transaction', length: Buffer.byteLength(payload) }),
        payload,
      ].join('\n') + '\n'
    )

    await app.inject({
      method: 'POST',
      url: `/api/${projectId}/envelope/`,
      headers: {
        'x-sentry-auth': `Sentry sentry_version=7, sentry_key=${publicKey}`,
        'content-type': 'application/x-sentry-envelope',
      },
      payload: raw,
    })

    const received = (await data) as { event: { transaction: string } }
    await worker.close()
    expect(received.event.transaction).toBe('GET /api/widgets')
  })

  it('archives the raw envelope bytes before enqueueing', async () => {
    const { data, worker } = waitForOneJob('ingest.errors')

    const eventId = `archive-${Date.now()}`
    await app.inject({
      method: 'POST',
      url: `/api/${projectId}/envelope/`,
      headers: {
        'x-sentry-auth': `Sentry sentry_version=7, sentry_key=${publicKey}`,
        'content-type': 'application/x-sentry-envelope',
      },
      payload: envelopeBuffer(eventId),
    })

    await data
    await worker.close()

    const archived = await db
      .selectFrom('raw_envelope')
      .selectAll()
      .where('project_id', '=', projectId)
      .where('event_id', '=', eventId)
      .executeTakeFirstOrThrow()
    expect(Buffer.from(archived.raw_bytes).equals(envelopeBuffer(eventId))).toBe(true)
  })
})
