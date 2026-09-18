import type { Kysely } from 'kysely'
import type { Database } from '@flare/db'
import type { TransactionItem } from '@flare/shared-types'

export async function upsertTransaction(
  db: Kysely<Database>,
  params: { projectId: string; environmentId: string; releaseId: string | null; transaction: TransactionItem }
): Promise<{ transactionId: string; hourBucket: Date }> {
  const { transaction } = params
  const startTs = new Date(transaction.start_timestamp * 1000)
  const durationMs = Math.round((transaction.timestamp - transaction.start_timestamp) * 1000)

  return db.transaction().execute(async (trx) => {
    const row = await trx
      .insertInto('transaction')
      .values({
        project_id: params.projectId,
        environment_id: params.environmentId,
        release_id: params.releaseId,
        trace_id: transaction.contexts.trace.trace_id,
        name: transaction.transaction,
        op: transaction.contexts.trace.op ?? null,
        status: transaction.contexts.trace.status ?? null,
        start_ts: startTs,
        duration_ms: durationMs,
      })
      .returning('id')
      .executeTakeFirstOrThrow()

    if (transaction.spans.length > 0) {
      await trx
        .insertInto('span')
        .values(
          transaction.spans.map((span) => ({
            transaction_id: row.id,
            trace_id: transaction.contexts.trace.trace_id,
            span_id: span.span_id,
            parent_span_id: span.parent_span_id ?? null,
            op: span.op ?? null,
            description: span.description ?? null,
            start_ts: new Date(span.start_timestamp * 1000),
            duration_ms: Math.round((span.timestamp - span.start_timestamp) * 1000),
          }))
        )
        .execute()
    }

    const hourBucket = new Date(startTs)
    hourBucket.setUTCMinutes(0, 0, 0)

    return { transactionId: row.id, hourBucket }
  })
}
