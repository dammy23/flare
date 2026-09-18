import { createDb } from '@flare/db'
import Redis from 'ioredis'
import { startConsumer } from './consumer'
import { handleFlowCheckpointMessage } from './handle-message'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')
const queueConnection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null })

startConsumer(queueConnection, 'ingest.flow', (data) => handleFlowCheckpointMessage(db, data))
