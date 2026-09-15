import type { Kysely } from 'kysely'
import type { Database } from '@flare/db'
import { resolveEnvironment } from '@flare/db'
import type { Redis } from 'ioredis'
import { SentryEventItemSchema } from '@flare/shared-types'
import { computeFingerprint } from './fingerprint'
import { upsertIssueAndEvent } from './upsert-issue-event'

interface IngestErrorMessage {
  projectId: string
  event: unknown
}

export async function handleErrorMessage(db: Kysely<Database>, redis: Redis, rawValue: Buffer): Promise<void> {
  const parsed = JSON.parse(rawValue.toString('utf8')) as IngestErrorMessage
  const event = SentryEventItemSchema.parse(parsed.event)

  const environmentId = await resolveEnvironment(db, redis, parsed.projectId, event.environment)
  const fingerprint = computeFingerprint(event.exception)

  await upsertIssueAndEvent(db, {
    projectId: parsed.projectId,
    environmentId,
    fingerprint,
    event,
  })
}
