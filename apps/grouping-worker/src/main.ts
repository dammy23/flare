import { createDb } from '@flare/db'
import Redis from 'ioredis'
import { startConsumer } from './consumer'
import { handleErrorMessage } from './handle-message'
import { createQueueProducer } from './queue/producer'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379')
const queueConnection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null })
const producer = createQueueProducer(queueConnection)
const alerting = {
  webhookUrl: process.env.SLACK_WEBHOOK_URL ?? null,
  frequencyThreshold: Number(process.env.ALERT_FREQUENCY_THRESHOLD ?? 100),
}

startConsumer(queueConnection, 'ingest.errors', (data) => handleErrorMessage(db, redis, producer, data, alerting))
