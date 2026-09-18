import { createDb } from '@flare/db'
import { createStorageClient } from '@flare/storage'
import Redis from 'ioredis'
import { buildApp } from './app'
import { createQueueProducer } from './queue/producer'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379')
const queueConnection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null })
const producer = createQueueProducer(queueConnection)
const storage = createStorageClient({
  endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
  region: process.env.S3_REGION ?? 'us-east-1',
  accessKeyId: process.env.S3_ACCESS_KEY ?? 'flare',
  secretAccessKey: process.env.S3_SECRET_KEY ?? 'flare12345',
  bucket: process.env.S3_BUCKET ?? 'flare-source-maps',
})

async function main(): Promise<void> {
  const app = buildApp({ db, redis, producer, storage })
  await app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' })
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
