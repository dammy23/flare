import { createDb } from '@flare/db'
import { afterAll, describe, expect, it } from 'vitest'
import { refreshLatencyRollup } from './refresh-latency-rollup'
import { upsertTransaction } from './upsert-transaction'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')

afterAll(() => db.destroy())

describe('refreshLatencyRollup', () => {
  it('computes p50/p95/p99/count for the hour bucket from real transaction rows', async () => {
    const project = await db
      .insertInto('project')
      .values({ name: 'Rollup Test', slug: `rollup-test-${Date.now()}`, public_key: `pk-rollup-${Date.now()}` })
      .returningAll()
      .executeTakeFirstOrThrow()
    const environment = await db
      .insertInto('environment')
      .values({ project_id: project.id, name: 'production' })
      .returningAll()
      .executeTakeFirstOrThrow()

    const baseTs = 1700000000
    let hourBucket!: Date
    for (const durationSeconds of [0.1, 0.2, 0.3, 0.4, 1.0]) {
      const result = await upsertTransaction(db, {
        projectId: project.id,
        environmentId: environment.id,
        releaseId: null,
        transaction: {
          event_id: `tx-rollup-${Math.random()}`,
          transaction: 'GET /api/rollup-test',
          environment: 'production',
          start_timestamp: baseTs,
          timestamp: baseTs + durationSeconds,
          contexts: { trace: { trace_id: 'a'.repeat(32), span_id: 'b'.repeat(16) } },
          spans: [],
        },
      })
      hourBucket = result.hourBucket
    }

    await refreshLatencyRollup(
      db,
      { projectId: project.id, environmentId: environment.id, transactionName: 'GET /api/rollup-test' },
      hourBucket
    )

    const rollup = await db
      .selectFrom('transaction_latency_rollup')
      .selectAll()
      .where('project_id', '=', project.id)
      .where('environment_id', '=', environment.id)
      .where('transaction_name', '=', 'GET /api/rollup-test')
      .executeTakeFirstOrThrow()

    expect(rollup.count).toBe(5)
    expect(rollup.p50_ms).toBeGreaterThan(0)
    expect(rollup.p99_ms).toBeGreaterThanOrEqual(rollup.p95_ms)
    expect(rollup.p95_ms).toBeGreaterThanOrEqual(rollup.p50_ms)
  })
})
