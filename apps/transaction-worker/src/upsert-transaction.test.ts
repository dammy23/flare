import { createDb } from '@flare/db'
import { afterAll, describe, expect, it } from 'vitest'
import { upsertTransaction } from './upsert-transaction'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')

afterAll(() => db.destroy())

describe('upsertTransaction', () => {
  it('inserts a transaction with its spans', async () => {
    const project = await db
      .insertInto('project')
      .values({ name: 'Tx Test', slug: `tx-test-${Date.now()}`, public_key: `pk-tx-${Date.now()}` })
      .returningAll()
      .executeTakeFirstOrThrow()
    const environment = await db
      .insertInto('environment')
      .values({ project_id: project.id, name: 'production' })
      .returningAll()
      .executeTakeFirstOrThrow()

    const result = await upsertTransaction(db, {
      projectId: project.id,
      environmentId: environment.id,
      releaseId: null,
      transaction: {
        event_id: `tx-${Date.now()}`,
        transaction: 'GET /api/widgets',
        environment: 'production',
        start_timestamp: 1700000000,
        timestamp: 1700000000.25,
        contexts: { trace: { trace_id: 'a'.repeat(32), span_id: 'b'.repeat(16), op: 'http.server', status: 'ok' } },
        spans: [
          {
            span_id: 'c'.repeat(16),
            parent_span_id: 'b'.repeat(16),
            op: 'db.query',
            start_timestamp: 1700000000.05,
            timestamp: 1700000000.1,
          },
        ],
      },
    })

    const row = await db.selectFrom('transaction').selectAll().where('id', '=', result.transactionId).executeTakeFirstOrThrow()
    expect(row.duration_ms).toBe(250)
    expect(row.name).toBe('GET /api/widgets')

    const spans = await db.selectFrom('span').selectAll().where('transaction_id', '=', result.transactionId).execute()
    expect(spans).toHaveLength(1)
    expect(spans[0].duration_ms).toBe(50)
  })
})
