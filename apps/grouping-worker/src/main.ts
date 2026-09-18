import { createDb } from '@flare/db'
import Redis from 'ioredis'
import { startConsumer } from './consumer'
import { handleErrorMessage, type AlertingConfig } from './handle-message'
import { createQueueProducer } from './queue/producer'
import { createEmailTransport, sendEmailAlert } from './alerts/send-email-alert'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379')
const queueConnection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null })
const producer = createQueueProducer(queueConnection)

// Email alerting is opt-in: only enabled when both SMTP_HOST and
// ALERT_EMAIL_TO are configured at deploy time. SMTP_USER/SMTP_PASS are
// optional (some internal relays accept unauthenticated mail).
function buildSendEmail(): AlertingConfig['sendEmail'] {
  const host = process.env.SMTP_HOST
  const to = process.env.ALERT_EMAIL_TO
  if (!host || !to) return null

  const emailConfig = {
    host,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER ?? null,
    pass: process.env.SMTP_PASS ?? null,
    from: process.env.ALERT_EMAIL_FROM ?? 'flare@localhost',
    to,
  }
  const transport = createEmailTransport(emailConfig)
  return (subject, text) => sendEmailAlert(transport, emailConfig, subject, text)
}

const alerting: AlertingConfig = {
  webhookUrl: process.env.SLACK_WEBHOOK_URL ?? null,
  frequencyThreshold: Number(process.env.ALERT_FREQUENCY_THRESHOLD ?? 100),
  sendEmail: buildSendEmail(),
}

startConsumer(queueConnection, 'ingest.errors', (data) => handleErrorMessage(db, redis, producer, data, alerting))
