import { createDb } from '@flare/db'
import Redis from 'ioredis'
import { startConsumer } from './consumer'
import { handleTransactionMessage } from './handle-message'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379')
const queueConnection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null })

startConsumer(queueConnection, 'ingest.transactions', (data) => handleTransactionMessage(db, redis, data))
