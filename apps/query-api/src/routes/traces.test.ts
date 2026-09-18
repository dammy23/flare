import { createDb } from '@flare/db'
import { afterAll, describe, expect, it } from 'vitest'
import { buildApp } from '../app'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')
const app = buildApp({ db, redis: {} as never, storage: {} as never })

afterAll(async () => {
  await db.destroy()
  await app.close()
})

describe('GET /api/v1/traces/:traceId', () => {
  it('returns the transaction and its spans for a trace', async () => {
    const project = await db
      .insertInto('project')
      .values({ name: 'Trace Test', slug: `trace-test-${Date.now()}`, public_key: `pk-trace-${Date.now()}` })
      .returningAll()
      .executeTakeFirstOrThrow()
    const environment = await db
      .insertInto('environment')
      .values({ project_id: project.id, name: 'production' })
      .returningAll()
      .executeTakeFirstOrThrow()
    const traceId = 'f'.repeat(32)
    const tx = await db
      .insertInto('transaction')
      .values({
        project_id: project.id,
        environment_id: environment.id,
        trace_id: traceId,
        name: 'GET /api/widgets',
        start_ts: new Date(),
        duration_ms: 120,
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    await db
      .insertInto('span')
      .values({ transaction_id: tx.id, trace_id: traceId, span_id: 'a'.repeat(16), start_ts: new Date(), duration_ms: 40 })
      .execute()

    const response = await app.inject({ method: 'GET', url: `/api/v1/traces/${traceId}` })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.transactions).toHaveLength(1)
    expect(body.spans).toHaveLength(1)
  })
})
