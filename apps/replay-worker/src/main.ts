import { createDb } from '@flare/db'
import { createStorageClient } from '@flare/storage'
import Redis from 'ioredis'
import { startConsumer } from './consumer'
import { handleReplayMessage } from './handle-message'

const brokers = (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(',')
const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379')
const storage = createStorageClient({
  endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
  region: process.env.S3_REGION ?? 'us-east-1',
  accessKeyId: process.env.S3_ACCESS_KEY ?? 'flare',
  secretAccessKey: process.env.S3_SECRET_KEY ?? 'flare12345',
  bucket: process.env.S3_BUCKET ?? 'flare-source-maps',
})

startConsumer(brokers, 'replay-worker', 'ingest.replays', (value) => handleReplayMessage({ db, redis, storage }, value)).catch(
  (error) => {
    console.error(error)
    process.exit(1)
  }
)
