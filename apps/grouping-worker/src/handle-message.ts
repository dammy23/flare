import type { Kysely } from 'kysely'
import type { Database } from '@flare/db'
import { resolveEnvironment, resolveOrCreateRelease } from '@flare/db'
import type { Redis } from 'ioredis'
import { SentryEventItemSchema } from '@flare/shared-types'
import { computeFingerprint } from './fingerprint'
import { upsertIssueAndEvent } from './upsert-issue-event'
import type { EventProducer } from './kafka/producer'

interface IngestErrorMessage {
  projectId: string
  event: unknown
}

export async function handleErrorMessage(
  db: Kysely<Database>,
  redis: Redis,
  producer: EventProducer,
  rawValue: Buffer
): Promise<void> {
  const parsed = JSON.parse(rawValue.toString('utf8')) as IngestErrorMessage
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
      `${parsed.projectId}:${result.eventId}`,
      JSON.stringify({ projectId: parsed.projectId, eventId: result.eventId, releaseId, exception: event.exception })
    )
  }
}
