import type { Kysely } from 'kysely'
import type { Database } from '@flare/db'
import { resolveEnvironment, resolveOrCreateRelease } from '@flare/db'
import type { Redis } from 'ioredis'
import { SentryEventItemSchema } from '@flare/shared-types'
import { computeFingerprint } from './fingerprint'
import { upsertIssueAndEvent } from './upsert-issue-event'
import type { QueueProducer } from './queue/producer'
import { sendSlackWebhook } from './alerts/send-slack-webhook'

interface IngestErrorMessage {
  projectId: string
  event: unknown
}

export interface AlertingConfig {
  webhookUrl: string | null
  frequencyThreshold: number
  // A plain function rather than an EmailAlertConfig/Transporter, so this
  // module stays decoupled from nodemailer specifics -- main.ts owns
  // constructing the transport, same division of responsibility as
  // `producer`/`db`/`redis` being pre-built and injected rather than
  // configured from env vars in here.
  sendEmail: ((subject: string, text: string) => Promise<void>) | null
}

const DEFAULT_ALERTING: AlertingConfig = { webhookUrl: null, frequencyThreshold: 100, sendEmail: null }

async function fireAlert(alerting: AlertingConfig, subject: string, text: string): Promise<void> {
  await Promise.all([
    alerting.webhookUrl ? sendSlackWebhook(alerting.webhookUrl, text) : null,
    alerting.sendEmail ? alerting.sendEmail(subject, text) : null,
  ])
}

export async function handleErrorMessage(
  db: Kysely<Database>,
  redis: Redis,
  producer: QueueProducer,
  data: unknown,
  alerting: AlertingConfig = DEFAULT_ALERTING
): Promise<void> {
  const parsed = data as IngestErrorMessage
  const event = SentryEventItemSchema.parse(parsed.event)

  const environmentId = await resolveEnvironment(db, redis, parsed.projectId, event.environment)
  const releaseId = event.release
    ? await resolveOrCreateRelease(db, redis, parsed.projectId, event.release)
    : null
  const fingerprint = computeFingerprint(event.exception)

  const result = await upsertIssueAndEvent(db, {
    projectId: parsed.projectId,
    environmentId,
    releaseId,
    fingerprint,
    event,
  })

  if (releaseId && event.exception) {
    await producer.send(
      'work.symbolication',
      'symbolicate',
      { projectId: parsed.projectId, eventId: result.eventId, releaseId, exception: event.exception },
      { attempts: 5, backoff: { type: 'exponential', delay: 1000 } }
    )
  }

  if (result.created) {
    await fireAlert(alerting, 'Flare: new issue', `New issue: ${result.title}`)
  } else if (result.timesSeen === alerting.frequencyThreshold) {
    await fireAlert(
      alerting,
      'Flare: issue threshold reached',
      `Issue "${result.title}" has now occurred ${result.timesSeen} times`
    )
  }
}
