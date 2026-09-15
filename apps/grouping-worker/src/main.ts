import { createDb } from '@flare/db'
import Redis from 'ioredis'
import { startConsumer } from './consumer'
import { handleErrorMessage } from './handle-message'

const brokers = (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(',')
const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379')

startConsumer(brokers, 'grouping-worker', 'ingest.errors', (value) => handleErrorMessage(db, redis, value)).catch(
  (error) => {
    console.error(error)
    process.exit(1)
  }
)
