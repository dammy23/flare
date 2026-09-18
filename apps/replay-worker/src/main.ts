import { createDb } from '@flare/db'
import { createStorageClient } from '@flare/storage'
import Redis from 'ioredis'
import { startConsumer } from './consumer'
import { handleReplayMessage } from './handle-message'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379')
const queueConnection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null })
const storage = createStorageClient({
  endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
  region: process.env.S3_REGION ?? 'us-east-1',
  accessKeyId: process.env.S3_ACCESS_KEY ?? 'flare',
  secretAccessKey: process.env.S3_SECRET_KEY ?? 'flare12345',
  bucket: process.env.S3_BUCKET ?? 'flare-source-maps',
})

startConsumer(queueConnection, 'ingest.replays', (data) => handleReplayMessage({ db, redis, storage }, data))
