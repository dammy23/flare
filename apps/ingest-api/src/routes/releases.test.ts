import { createDb } from '@flare/db'
import { createStorageClient } from '@flare/storage'
import Redis from 'ioredis'
import FormData from 'form-data'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../app'
import { createQueueProducer } from '../queue/producer'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379')
const queueConnection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null })
const producer = createQueueProducer(queueConnection)
const storage = createStorageClient({
  endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
  region: 'us-east-1',
  accessKeyId: process.env.S3_ACCESS_KEY ?? 'flare',
  secretAccessKey: process.env.S3_SECRET_KEY ?? 'flare12345',
  bucket: process.env.S3_BUCKET ?? 'flare-source-maps',
})
const app = buildApp({ db, redis, producer, storage })

let publicKey: string

beforeAll(async () => {
  publicKey = `pk-releases-${Date.now()}`
  await db
    .insertInto('project')
    .values({ name: 'Releases Test', slug: `releases-test-${Date.now()}`, public_key: publicKey })
    .execute()
})

afterAll(async () => {
  await producer.close()
  await db.destroy()
  redis.disconnect()
  queueConnection.disconnect()
  await app.close()
})

describe('POST /api/0/organizations/:org/releases/', () => {
  it('creates a release scoped by the bearer public key', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/0/organizations/flare-org/releases/',
      headers: { authorization: `Bearer ${publicKey}` },
      payload: { version: '1.0.0-releases-test' },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json().version).toBe('1.0.0-releases-test')
  })
})

describe('POST /api/0/organizations/:org/releases/:version/files/', () => {
  it('uploads a source-map artifact and stores it', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/0/organizations/flare-org/releases/',
      headers: { authorization: `Bearer ${publicKey}` },
      payload: { version: '1.0.0-upload-test' },
    })

    const form = new FormData()
    form.append('name', 'app.js.map')
    form.append('file', Buffer.from('{"version":3,"sources":[]}'), { filename: 'app.js.map' })

    const response = await app.inject({
      method: 'POST',
      url: '/api/0/organizations/flare-org/releases/1.0.0-upload-test/files/',
      headers: { authorization: `Bearer ${publicKey}`, ...form.getHeaders() },
      payload: form.getBuffer(),
    })

    expect(response.statusCode).toBe(201)

    const stored = await storage.getObject(response.json().storageKey)
    expect(stored.toString('utf8')).toContain('"version":3')
  })
})
