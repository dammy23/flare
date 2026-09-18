import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { Database } from '@flare/db'

export interface LatencyRollupScope {
  projectId: string
  environmentId: string
  transactionName: string
}

export async function refreshLatencyRollup(
  db: Kysely<Database>,
  scope: LatencyRollupScope,
  hourBucket: Date
): Promise<void> {
  const hourEnd = new Date(hourBucket.getTime() + 60 * 60 * 1000)

  const stats = await db
    .selectFrom('transaction')
    .select([
      sql<number>`percentile_cont(0.5) within group (order by duration_ms)`.as('p50'),
      sql<number>`percentile_cont(0.95) within group (order by duration_ms)`.as('p95'),
      sql<number>`percentile_cont(0.99) within group (order by duration_ms)`.as('p99'),
      sql<number>`count(*)`.as('count'),
    ])
    .where('project_id', '=', scope.projectId)
    .where('environment_id', '=', scope.environmentId)
    .where('name', '=', scope.transactionName)
    .where('start_ts', '>=', hourBucket)
    .where('start_ts', '<', hourEnd)
    .executeTakeFirstOrThrow()

  await db
    .insertInto('transaction_latency_rollup')
    .values({
      project_id: scope.projectId,
      environment_id: scope.environmentId,
      transaction_name: scope.transactionName,
      hour_bucket: hourBucket,
      p50_ms: stats.p50,
      p95_ms: stats.p95,
      p99_ms: stats.p99,
      count: stats.count,
    })
    .onConflict((oc) =>
      oc
        .columns(['project_id', 'environment_id', 'transaction_name', 'hour_bucket'])
        .doUpdateSet({ p50_ms: stats.p50, p95_ms: stats.p95, p99_ms: stats.p99, count: stats.count })
    )
    .execute()
}
