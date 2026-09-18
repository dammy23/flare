import type { Kysely } from 'kysely'
import type { Database } from '@flare/db'
import { resolveEnvironment, resolveOrCreateRelease } from '@flare/db'
import type { Redis } from 'ioredis'
import { TransactionItemSchema } from '@flare/shared-types'
import { upsertTransaction } from './upsert-transaction'
import { refreshLatencyRollup } from './refresh-latency-rollup'

interface IngestTransactionMessage {
  projectId: string
  event: unknown
}

export async function handleTransactionMessage(db: Kysely<Database>, redis: Redis, data: unknown): Promise<void> {
  const parsed = data as IngestTransactionMessage
  const transaction = TransactionItemSchema.parse(parsed.event)

  const environmentId = await resolveEnvironment(db, redis, parsed.projectId, transaction.environment)
  const releaseId = transaction.release
    ? await resolveOrCreateRelease(db, redis, parsed.projectId, transaction.release)
    : null

  const { hourBucket } = await upsertTransaction(db, {
    projectId: parsed.projectId,
    environmentId,
    releaseId,
    transaction,
  })

  await refreshLatencyRollup(
    db,
    { projectId: parsed.projectId, environmentId, transactionName: transaction.transaction },
    hourBucket
  )
}
