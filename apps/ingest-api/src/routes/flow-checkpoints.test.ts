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
  publicKey = `pk-flow-checkpoint-${Date.now()}`
  const inserted = await db
    .insertInto('project')
    .values({ name: 'Flow Checkpoint Test', slug: `flow-checkpoint-test-${Date.now()}`, public_key: publicKey })
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

describe('POST /api/v1/flows/checkpoints', () => {
  it('enqueues a valid checkpoint to ingest.flow and returns 202', async () => {
    const { data, worker } = waitForOneJob('ingest.flow')

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/flows/checkpoints',
      headers: { authorization: `Bearer ${publicKey}`, 'content-type': 'application/json' },
      payload: {
        stage: 'received',
        system: 'CRM',
        entityIds: [{ system: 'CRM', entityId: 'WO-123' }],
        dedupKey: `crm:WO-123:received:${Date.now()}`,
        occurredAt: new Date().toISOString(),
      },
    })

    expect(response.statusCode).toBe(202)

    const received = (await data) as { projectId: string; checkpoint: { stage: string } }
    await worker.close()
    expect(received.projectId).toBe(projectId)
    expect(received.checkpoint.stage).toBe('received')
  })

  it('returns 401 when the bearer token is missing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/flows/checkpoints',
      headers: { 'content-type': 'application/json' },
      payload: {
        stage: 'received',
        system: 'CRM',
        entityIds: [{ system: 'CRM', entityId: 'WO-999' }],
        dedupKey: 'irrelevant',
        occurredAt: new Date().toISOString(),
      },
    })
    expect(response.statusCode).toBe(401)
  })

  it('returns 401 when the bearer token is unknown', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/flows/checkpoints',
      headers: { authorization: 'Bearer not-a-real-key', 'content-type': 'application/json' },
      payload: {
        stage: 'received',
        system: 'CRM',
        entityIds: [{ system: 'CRM', entityId: 'WO-999' }],
        dedupKey: 'irrelevant',
        occurredAt: new Date().toISOString(),
      },
    })
    expect(response.statusCode).toBe(401)
  })

  it('returns 400 for a schema-invalid body (empty entityIds)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/flows/checkpoints',
      headers: { authorization: `Bearer ${publicKey}`, 'content-type': 'application/json' },
      payload: {
        stage: 'received',
        system: 'CRM',
        entityIds: [],
        dedupKey: 'irrelevant',
        occurredAt: new Date().toISOString(),
      },
    })
    expect(response.statusCode).toBe(400)
  })
})
