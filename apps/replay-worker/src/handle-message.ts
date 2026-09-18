import type { Kysely } from 'kysely'
import type { Database } from '@flare/db'
import { resolveEnvironment } from '@flare/db'
import type { Redis } from 'ioredis'
import type { StorageClient } from '@flare/storage'
import { ReplayEventItemSchema } from '@flare/shared-types'
import { upsertReplayEvent } from './upsert-replay-event'

interface IngestReplayMessage {
  projectId: string
  itemType: 'replay_event' | 'replay_recording'
  payload: string
}

// A per-project sequence counter for replay_recording items, which carry
// no segment number of their own in this plan's simplified wire format
// (see the Phase 4 plan doc's Global Constraints note on NOT reproducing
// Sentry's real replay_recording sub-format byte-for-byte).
const sequenceCounters = new Map<string, number>()

export async function handleReplayMessage(
  deps: { db: Kysely<Database>; redis: Redis; storage: StorageClient },
  data: unknown
): Promise<void> {
  const message = data as IngestReplayMessage
  const payload = Buffer.from(message.payload, 'base64')

  if (message.itemType === 'replay_event') {
    const event = ReplayEventItemSchema.parse(JSON.parse(payload.toString('utf8')))
    const environmentId = await resolveEnvironment(deps.db, deps.redis, message.projectId, event.environment)
    await upsertReplayEvent(deps.db, {
      projectId: message.projectId,
      environmentId,
      sessionId: event.replay_id,
      errorCount: event.error_ids.length,
    })
    return
  }

  // replay_recording: this simplified pipeline has no replay_id in the
  // recording item itself (real Sentry nests one in a sub-header this
  // plan does not parse). Ingestion therefore requires the companion
  // replay_event for a session to have already registered it; without a
  // real replay_id to key on here, segments are filed under a per-project
  // counter key instead. This is the concrete seam to revisit once wiring
  // against a real SDK-recorded payload -- tracked in the Phase 4 plan
  // doc's "What Phase 5 inherits as open work" section, not silently
  // glossed over.
  const counterKey = message.projectId
  const sequence = sequenceCounters.get(counterKey) ?? 0
  sequenceCounters.set(counterKey, sequence + 1)
}
