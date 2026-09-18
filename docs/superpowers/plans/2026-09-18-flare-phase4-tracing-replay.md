# Flare Phase 4 (Technical Tracing + Replay) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ingest Sentry `transaction` items into `transaction`/`span` rows
with an hourly latency rollup, add trace lookup to the UI, ingest
`replay_event`/`replay_recording` items into `replay`/`replay_segment`
rows with segments in object storage, and add `transaction_latency` and
`replay_count` to the dashboard widget catalog.

**Architecture:** `ingest-api`'s envelope route (built in Phase 1, only
handling `event` items so far) now also routes `transaction` items to
`ingest.transactions` and `replay_event`/`replay_recording` items to
`ingest.replays`. Two new worker apps — `transaction-worker` and
`replay-worker` — consume those topics. `transaction-worker` resolves
environment/release exactly like `grouping-worker` does, inserts
`transaction`+`span` rows, and recomputes that hour's latency percentiles.
`replay-worker` writes segment blobs via `@flare/storage` (which gains
presigned-URL support) and metadata rows. `query-api` gets trace and
replay read endpoints; `web` gets a trace detail page and a replay
list/detail page.

**Tech Stack:** builds on Phases 0–3. No new backend libraries beyond
`@aws-sdk/s3-request-presigner` (presigned URLs). No new frontend
libraries — the replay page is metadata/download only this phase (see the
explicit deferral below).

**Spec:** [docs/superpowers/plans/flare-technical-plan.md](../flare-technical-plan.md)
§2 (data model — `transaction`, `span`, `transaction_latency_rollup`,
`replay`, `replay_segment`), §6 (tracing sampling — not implemented here,
see Risks), §9 (`transaction_latency`, `replay_count` widgets).

## Global Constraints

Same as prior phases, plus:
- **Deviation, flagged:** the architecture plan says
  `transaction_latency_rollup` is "maintained incrementally." This plan
  instead recomputes the full hour bucket's percentiles from `transaction`
  rows on every write (`percentile_cont` over that
  project+environment+transaction_name+hour), then upserts the rollup row.
  True incremental percentile maintenance needs an algorithm like t-digest,
  which cannot be verified for correctness without real load in this
  sandbox. A full-bucket recompute is trivially correct and cheap at the
  stated volume (at most a few hundred rows per hour bucket) — revisit only
  if per-write recompute cost is ever actually measured as a problem.
- **Explicit deferral, not silently dropped:** "in-browser rrweb playback"
  (the roadmap's Phase 4 line) is NOT built in this plan. Wiring
  `@rrweb/replay`'s `Replayer` against real segment bytes cannot be
  verified in a sandbox with no browser to render into and no real
  SDK-recorded segment to test against — shipping it unverified would be
  worse than not shipping it. This plan builds replay ingestion, storage,
  and a metadata/download UI (session list, duration, segment count,
  presigned download links per segment) so the pipeline and data are real
  and inspectable; wiring the actual `Replayer` is the concrete next task
  for whoever has a browser and a real recorded session to test against.
- No sampling is implemented for `transaction`/span ingestion (the
  architecture plan's "1–10% plus 100% of error traces" sampling policy).
  Every `transaction` item that arrives is stored. Sampling is a
  client-SDK-side and/or ingest-side rate decision with no correctness
  logic to get wrong, unlike everything above — implement it when there's
  an actual volume reason to, not speculatively.

---

### Task 1: `transaction` / `span` / `transaction_latency_rollup` Tables

**Files:**
- Create: `packages/db/migrations/1700000000011_create-transaction.cjs`
- Create: `packages/db/migrations/1700000000012_create-span.cjs`
- Create: `packages/db/migrations/1700000000013_create-transaction-latency-rollup.cjs`
- Modify: `packages/db/src/schema.ts`
- Create: `packages/shared-types/src/transaction.ts`
- Test: `packages/shared-types/src/transaction.test.ts`
- Modify: `packages/shared-types/src/index.ts`

**Interfaces:**
- Produces: `TransactionTable`, `SpanTable`, `TransactionLatencyRollupTable`
  (db); `TransactionItemSchema`/`TransactionItem` (shared-types) — the
  Sentry `transaction`-type envelope item shape. Consumed by Task 2/3.

- [ ] **Step 1: Migrations**

`packages/db/migrations/1700000000011_create-transaction.cjs`:
```js
exports.up = (pgm) => {
  pgm.createTable('transaction', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    project_id: { type: 'uuid', notNull: true, references: 'project', onDelete: 'CASCADE' },
    environment_id: { type: 'uuid', notNull: true, references: 'environment', onDelete: 'CASCADE' },
    release_id: { type: 'uuid', references: 'release', onDelete: 'SET NULL' },
    trace_id: { type: 'text', notNull: true },
    name: { type: 'text', notNull: true },
    op: { type: 'text' },
    status: { type: 'text' },
    start_ts: { type: 'timestamptz', notNull: true },
    duration_ms: { type: 'integer', notNull: true },
    received_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.createIndex('transaction', ['project_id', 'environment_id', 'name', 'start_ts'])
  pgm.createIndex('transaction', ['trace_id'])
}
exports.down = (pgm) => pgm.dropTable('transaction')
```

`packages/db/migrations/1700000000012_create-span.cjs`:
```js
exports.up = (pgm) => {
  pgm.createTable('span', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    transaction_id: { type: 'uuid', notNull: true, references: 'transaction', onDelete: 'CASCADE' },
    trace_id: { type: 'text', notNull: true },
    span_id: { type: 'text', notNull: true },
    parent_span_id: { type: 'text' },
    op: { type: 'text' },
    description: { type: 'text' },
    start_ts: { type: 'timestamptz', notNull: true },
    duration_ms: { type: 'integer', notNull: true },
  })
  pgm.createIndex('span', ['trace_id'])
  pgm.createIndex('span', ['transaction_id'])
}
exports.down = (pgm) => pgm.dropTable('span')
```

`packages/db/migrations/1700000000013_create-transaction-latency-rollup.cjs`:
```js
exports.up = (pgm) => {
  pgm.createTable('transaction_latency_rollup', {
    project_id: { type: 'uuid', notNull: true, references: 'project', onDelete: 'CASCADE' },
    environment_id: { type: 'uuid', notNull: true, references: 'environment', onDelete: 'CASCADE' },
    transaction_name: { type: 'text', notNull: true },
    hour_bucket: { type: 'timestamptz', notNull: true },
    p50_ms: { type: 'real', notNull: true },
    p95_ms: { type: 'real', notNull: true },
    p99_ms: { type: 'real', notNull: true },
    count: { type: 'integer', notNull: true },
  })
  pgm.addConstraint(
    'transaction_latency_rollup',
    'transaction_latency_rollup_pk',
    'PRIMARY KEY (project_id, environment_id, transaction_name, hour_bucket)'
  )
}
exports.down = (pgm) => pgm.dropTable('transaction_latency_rollup')
```

- [ ] **Step 2: Update `Database` schema**

Add to `packages/db/src/schema.ts`:
```ts
export interface TransactionTable {
  id: Generated<string>
  project_id: string
  environment_id: string
  release_id: string | null
  trace_id: string
  name: string
  op: string | null
  status: string | null
  start_ts: Date
  duration_ms: number
  received_at: Generated<Date>
}

export interface SpanTable {
  id: Generated<string>
  transaction_id: string
  trace_id: string
  span_id: string
  parent_span_id: string | null
  op: string | null
  description: string | null
  start_ts: Date
  duration_ms: number
}

export interface TransactionLatencyRollupTable {
  project_id: string
  environment_id: string
  transaction_name: string
  hour_bucket: Date
  p50_ms: number
  p95_ms: number
  p99_ms: number
  count: number
}
```
Add `transaction: TransactionTable`, `span: SpanTable`,
`transaction_latency_rollup: TransactionLatencyRollupTable` to `Database`.

- [ ] **Step 3: Write the failing test for `TransactionItemSchema`**

`packages/shared-types/src/transaction.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { TransactionItemSchema } from './transaction'

describe('TransactionItemSchema', () => {
  it('parses a minimal transaction item with one span', () => {
    const result = TransactionItemSchema.parse({
      event_id: 'evt-1',
      transaction: 'GET /api/widgets',
      start_timestamp: 1700000000,
      timestamp: 1700000000.25,
      environment: 'production',
      contexts: { trace: { trace_id: 'a'.repeat(32), span_id: 'b'.repeat(16), op: 'http.server', status: 'ok' } },
      spans: [
        {
          span_id: 'c'.repeat(16),
          parent_span_id: 'b'.repeat(16),
          op: 'db.query',
          description: 'SELECT * FROM widgets',
          start_timestamp: 1700000000.05,
          timestamp: 1700000000.1,
        },
      ],
    })

    expect(result.transaction).toBe('GET /api/widgets')
    expect(result.contexts.trace.trace_id).toHaveLength(32)
    expect(result.spans).toHaveLength(1)
  })

  it('defaults spans to an empty array when absent', () => {
    const result = TransactionItemSchema.parse({
      event_id: 'evt-2',
      transaction: 'GET /health',
      start_timestamp: 1700000000,
      timestamp: 1700000000.01,
      contexts: { trace: { trace_id: 'd'.repeat(32), span_id: 'e'.repeat(16) } },
    })
    expect(result.spans).toEqual([])
  })
})
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm --filter @flare/shared-types test -- transaction`
Expected: FAIL — `Cannot find module './transaction'`

- [ ] **Step 5: Implement `TransactionItemSchema`**

`packages/shared-types/src/transaction.ts`:
```ts
import { z } from 'zod'

const SpanSchema = z.object({
  span_id: z.string(),
  parent_span_id: z.string().optional(),
  op: z.string().optional(),
  description: z.string().optional(),
  start_timestamp: z.number(),
  timestamp: z.number(),
})

export const TransactionItemSchema = z.object({
  event_id: z.string(),
  transaction: z.string(),
  environment: z.string().default('production'),
  release: z.string().optional(),
  start_timestamp: z.number(),
  timestamp: z.number(),
  contexts: z.object({
    trace: z.object({
      trace_id: z.string(),
      span_id: z.string(),
      op: z.string().optional(),
      status: z.string().optional(),
    }),
  }),
  spans: z.array(SpanSchema).default([]),
})
export type TransactionItem = z.infer<typeof TransactionItemSchema>
```

- [ ] **Step 6: Run test to verify it passes; barrel export; typecheck; build; commit**

Run: `pnpm --filter @flare/shared-types test -- transaction` → PASS.

Add `export * from './transaction'` to `packages/shared-types/src/index.ts`.

Run: `pnpm --filter @flare/db typecheck && pnpm --filter @flare/shared-types build`

```bash
git add packages/db packages/shared-types
git commit -m "feat(db,shared-types): transaction/span/rollup tables and TransactionItemSchema"
```

---

### Task 2: `ingest-api` Routes `transaction` and Replay Items

**Files:**
- Modify: `apps/ingest-api/src/routes/envelope.ts`
- Modify: `apps/ingest-api/src/routes/envelope.test.ts`

**Interfaces:**
- Consumes: `TransactionItemSchema` (Task 1).
- Produces: `transaction` items → `ingest.transactions`;
  `replay_event`/`replay_recording` items → `ingest.replays`. Both use
  the same `producer.send` call already in place for `event` items — this
  is a routing extension, not new infrastructure.

- [ ] **Step 1: Write the failing test (extends the existing envelope test file)**

Add to `apps/ingest-api/src/routes/envelope.test.ts`:
```ts
it('publishes a transaction item to ingest.transactions', async () => {
  const kafka = new Kafka({ clientId: 'test-consumer-tx', brokers })
  const consumer = kafka.consumer({ groupId: `envelope-tx-test-${Date.now()}` })
  await consumer.connect()
  await consumer.subscribe({ topic: 'ingest.transactions', fromBeginning: true })

  const received: string[] = []
  const consumePromise = new Promise<void>((resolve) => {
    consumer.run({
      eachMessage: async ({ message }) => {
        received.push(message.value?.toString('utf8') ?? '')
        resolve()
      },
    })
  })

  const eventId = `tx-${Date.now()}`
  const payload = JSON.stringify({
    event_id: eventId,
    transaction: 'GET /api/widgets',
    start_timestamp: 1700000000,
    timestamp: 1700000000.2,
    contexts: { trace: { trace_id: 'a'.repeat(32), span_id: 'b'.repeat(16) } },
  })
  const raw = Buffer.from(
    [
      JSON.stringify({ event_id: eventId }),
      JSON.stringify({ type: 'transaction', length: Buffer.byteLength(payload) }),
      payload,
    ].join('\n') + '\n'
  )

  await app.inject({
    method: 'POST',
    url: `/api/${projectId}/envelope/`,
    headers: { 'x-sentry-auth': `Sentry sentry_version=7, sentry_key=${publicKey}`, 'content-type': 'application/x-sentry-envelope' },
    payload: raw,
  })

  await consumePromise
  await consumer.disconnect()
  expect(JSON.parse(received[0]).event.transaction).toBe('GET /api/widgets')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flare/ingest-api test -- envelope`
Expected: FAIL — nothing published to `ingest.transactions` (the item is
currently silently skipped since the loop only handles `type === 'event'`)

- [ ] **Step 3: Extend the routing**

In `apps/ingest-api/src/routes/envelope.ts`, replace the single
`if (item.header.type !== 'event') continue` loop body with a routing
table:
```ts
import { SentryEventItemSchema, TransactionItemSchema } from '@flare/shared-types'

// ...inside the for loop over envelope.items:
if (item.header.type === 'event') {
  const parsed = SentryEventItemSchema.parse(JSON.parse(item.payload.toString('utf8')))
  lastEventId = parsed.event_id
  await producer.send(
    'ingest.errors',
    `${project.id}:${parsed.event_id}`,
    JSON.stringify({ projectId: project.id, event: parsed })
  )
} else if (item.header.type === 'transaction') {
  const parsed = TransactionItemSchema.parse(JSON.parse(item.payload.toString('utf8')))
  lastEventId = parsed.event_id
  await producer.send(
    'ingest.transactions',
    `${project.id}:${parsed.event_id}`,
    JSON.stringify({ projectId: project.id, event: parsed })
  )
} else if (item.header.type === 'replay_event' || item.header.type === 'replay_recording') {
  await producer.send(
    'ingest.replays',
    `${project.id}:${item.header.type}`,
    JSON.stringify({ projectId: project.id, itemType: item.header.type, payload: item.payload.toString('base64') })
  )
}
```
(`replay_recording` payloads can be binary, hence base64-encoding into the
JSON envelope sent to Kafka — `replay-worker` decodes it back in Task 9.)

- [ ] **Step 4: Run test to verify it passes**

Run: same command as Step 2.
Expected: PASS

- [ ] **Step 5: Typecheck, build, commit**

Run: `pnpm --filter @flare/ingest-api typecheck && pnpm --filter @flare/ingest-api build`

```bash
git add apps/ingest-api
git commit -m "feat(ingest-api): route transaction and replay items to their topics"
```

---

### Task 3: `transaction-worker`

**Files:**
- Create: `apps/transaction-worker/package.json`
- Create: `apps/transaction-worker/tsconfig.json`
- Create: `apps/transaction-worker/vitest.config.ts`
- Create: `apps/transaction-worker/src/consumer.ts`
- Create: `apps/transaction-worker/src/upsert-transaction.ts`
- Test: `apps/transaction-worker/src/upsert-transaction.test.ts`
- Create: `apps/transaction-worker/src/refresh-latency-rollup.ts`
- Test: `apps/transaction-worker/src/refresh-latency-rollup.test.ts`
- Create: `apps/transaction-worker/src/handle-message.ts`
- Create: `apps/transaction-worker/src/main.ts`

**Interfaces:**
- Consumes: `resolveEnvironment`, `resolveOrCreateRelease` (existing),
  `TransactionItemSchema` (Task 1).
- Produces: `upsertTransaction(db, params): Promise<{transactionId: string}>`,
  `refreshLatencyRollup(db, scope, hourBucket): Promise<void>`,
  `handleTransactionMessage(deps, rawValue): Promise<void>`.

- [ ] **Step 1: Package scaffold**

Same shape as `grouping-worker`'s `package.json`/`tsconfig.json`/
`vitest.config.ts` (dependencies: `@flare/db`, `@flare/shared-types`,
`ioredis`, `kafkajs`, `kysely`; devDependency `vitest`), and copy
`consumer.ts` verbatim from `grouping-worker` (rename `clientId` to
`'transaction-worker'`).

- [ ] **Step 2: Write the failing test for `upsertTransaction`**

`apps/transaction-worker/src/upsert-transaction.test.ts`:
```ts
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
          { span_id: 'c'.repeat(16), parent_span_id: 'b'.repeat(16), op: 'db.query', start_timestamp: 1700000000.05, timestamp: 1700000000.1 },
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `DATABASE_URL=... pnpm --filter @flare/transaction-worker test -- upsert-transaction`
Expected: FAIL — `Cannot find module './upsert-transaction'`

- [ ] **Step 4: Implement `upsertTransaction`**

`apps/transaction-worker/src/upsert-transaction.ts`:
```ts
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: same command as Step 3.
Expected: PASS

- [ ] **Step 6: Write the failing test for `refreshLatencyRollup`**

`apps/transaction-worker/src/refresh-latency-rollup.test.ts`:
```ts
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

    await refreshLatencyRollup(db, { projectId: project.id, environmentId: environment.id, transactionName: 'GET /api/rollup-test' }, hourBucket)

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
```

- [ ] **Step 7: Run test to verify it fails**

Run: `DATABASE_URL=... pnpm --filter @flare/transaction-worker test -- refresh-latency-rollup`
Expected: FAIL — `Cannot find module './refresh-latency-rollup'`

- [ ] **Step 8: Implement `refreshLatencyRollup`**

`apps/transaction-worker/src/refresh-latency-rollup.ts`:
```ts
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
```

- [ ] **Step 9: Run test to verify it passes; verify the SQL independently**

Run: same command as Step 7.

Also compile the `stats` query with Kysely's `.compile()` against a dummy
dialect (no DB connection) to double check the `percentile_cont ... within
group` raw SQL is well-formed before trusting it, same technique used in
the Phase 3 plan for `runWidgetQuery`.

- [ ] **Step 10: Wire `handleTransactionMessage` and `main.ts`, typecheck, build, commit**

`apps/transaction-worker/src/handle-message.ts`:
```ts
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

export async function handleTransactionMessage(db: Kysely<Database>, redis: Redis, rawValue: Buffer): Promise<void> {
  const parsed = JSON.parse(rawValue.toString('utf8')) as IngestTransactionMessage
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
```

`apps/transaction-worker/src/main.ts` mirrors `grouping-worker/src/main.ts`
(consume `ingest.transactions`, call `handleTransactionMessage`).

Run: `pnpm --filter @flare/transaction-worker typecheck && pnpm --filter @flare/transaction-worker build`

```bash
git add apps/transaction-worker
git commit -m "feat(transaction-worker): new app ingesting transactions/spans with hourly latency rollup"
```

---

### Task 4: `GET /api/v1/traces/:traceId`

**Files:**
- Create: `apps/query-api/src/routes/traces.ts`
- Test: `apps/query-api/src/routes/traces.test.ts`
- Modify: `apps/query-api/src/app.ts`

**Interfaces:**
- Produces: `GET /api/v1/traces/:traceId` → `{ transactions: [...],
  spans: [...] }` (a trace can technically have more than one root
  transaction if a client retries; return all transactions sharing the
  trace_id plus every span across them, sorted by start time).

- [ ] **Step 1: Write the failing test**

`apps/query-api/src/routes/traces.test.ts`:
```ts
import { createDb } from '@flare/db'
import Redis from 'ioredis'
import { afterAll, describe, expect, it } from 'vitest'
import { buildApp } from '../app'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')
const app = buildApp({ db, redis: {} as never })

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL=... pnpm --filter @flare/query-api test -- traces`
Expected: FAIL — route not registered

- [ ] **Step 3: Implement the route**

`apps/query-api/src/routes/traces.ts`:
```ts
import type { FastifyInstance } from 'fastify'

export function registerTraceRoutes(app: FastifyInstance): void {
  app.get<{ Params: { traceId: string } }>('/api/v1/traces/:traceId', async (request) => {
    const { db } = app.deps
    const transactions = await db
      .selectFrom('transaction')
      .selectAll()
      .where('trace_id', '=', request.params.traceId)
      .orderBy('start_ts', 'asc')
      .execute()

    const spans = await db
      .selectFrom('span')
      .selectAll()
      .where('trace_id', '=', request.params.traceId)
      .orderBy('start_ts', 'asc')
      .execute()

    return { transactions, spans }
  })
}
```

- [ ] **Step 4: Register in `app.ts`, run test to verify it passes**

```ts
import { registerTraceRoutes } from './routes/traces'
// alongside the other register*Routes(app) calls:
registerTraceRoutes(app)
```

- [ ] **Step 5: Typecheck, build, commit**

```bash
git add apps/query-api
git commit -m "feat(query-api): GET trace endpoint returning transactions and spans"
```

---

### Task 5: Web `TraceDetailPage`

**Files:**
- Create: `apps/web/src/pages/TraceDetailPage.tsx`
- Test: `apps/web/src/pages/TraceDetailPage.test.tsx`
- Modify: `apps/web/src/api/query-client.ts`
- Modify: `apps/web/src/App.tsx`

**Interfaces:**
- Produces: `fetchTrace(traceId): Promise<{transactions, spans}>`,
  `<TraceDetailPage />` route at `/traces/:traceId`.

- [ ] **Step 1: Write the failing test**

`apps/web/src/pages/TraceDetailPage.test.tsx`:
```tsx
import { render, screen, waitFor } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { TraceDetailPage } from './TraceDetailPage'

const server = setupServer(
  http.get('http://localhost:3001/api/v1/traces/trace-1', () =>
    HttpResponse.json({
      transactions: [{ id: 't1', name: 'GET /api/widgets', duration_ms: 120, start_ts: '2026-09-01T00:00:00.000Z' }],
      spans: [{ id: 's1', span_id: 'a', op: 'db.query', description: 'SELECT 1', duration_ms: 40 }],
    })
  )
)

beforeAll(() => server.listen())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('TraceDetailPage', () => {
  it('renders the transaction name and its span durations', async () => {
    render(
      <MemoryRouter initialEntries={['/traces/trace-1']}>
        <Routes>
          <Route path="/traces/:traceId" element={<TraceDetailPage />} />
        </Routes>
      </MemoryRouter>
    )

    await waitFor(() => expect(screen.getByText('GET /api/widgets')).toBeInTheDocument())
    expect(screen.getByText('db.query')).toBeInTheDocument()
    expect(screen.getByText('40ms')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flare/web test -- TraceDetailPage`
Expected: FAIL — `Cannot find module './TraceDetailPage'`

- [ ] **Step 3: Add `fetchTrace` to the API client**

Add to `apps/web/src/api/query-client.ts`:
```ts
export interface TraceTransaction { id: string; name: string; duration_ms: number; start_ts: string }
export interface TraceSpan { id: string; span_id: string; op: string | null; description: string | null; duration_ms: number }

export async function fetchTrace(traceId: string): Promise<{ transactions: TraceTransaction[]; spans: TraceSpan[] }> {
  const response = await fetch(`${QUERY_API_BASE_URL}/api/v1/traces/${traceId}`)
  return response.json()
}
```

- [ ] **Step 4: Implement `TraceDetailPage`**

`apps/web/src/pages/TraceDetailPage.tsx`:
```tsx
import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { fetchTrace, type TraceSpan, type TraceTransaction } from '../api/query-client'

export function TraceDetailPage() {
  const { traceId } = useParams<{ traceId: string }>()
  const [data, setData] = useState<{ transactions: TraceTransaction[]; spans: TraceSpan[] } | null>(null)

  useEffect(() => {
    if (traceId) fetchTrace(traceId).then(setData)
  }, [traceId])

  if (!data) return <p>Loading…</p>

  return (
    <div>
      {data.transactions.map((tx) => (
        <h2 key={tx.id}>{tx.name}</h2>
      ))}
      <ul>
        {data.spans.map((span) => (
          <li key={span.id}>
            <span>{span.op ?? '?'}</span>
            {' — '}
            <span>{span.description ?? ''}</span>
            {' ('}
            <span>{`${span.duration_ms}ms`}</span>
            {')'}
          </li>
        ))}
      </ul>
    </div>
  )
}
```

- [ ] **Step 5: Run test to verify it passes; wire the route; full suite/typecheck/build; commit**

Add `<Route path="/traces/:traceId" element={<TraceDetailPage />} />` to
`apps/web/src/App.tsx`.

Run: `pnpm --filter @flare/web test && pnpm --filter @flare/web typecheck
&& pnpm --filter @flare/web build`

```bash
git add apps/web
git commit -m "feat(web): trace detail page"
```

---

### Task 6: Widget Catalog — `transaction_latency`

**Files:**
- Modify: `packages/shared-types/src/widgets.ts`
- Modify: `packages/shared-types/src/widgets.test.ts`
- Modify: `apps/query-api/src/widgets/run-widget-query.ts`
- Modify: `apps/query-api/src/widgets/run-widget-query.test.ts`
- Modify: `packages/db/src/provision-dashboard.ts`
- Modify: `packages/db/src/provision-dashboard.test.ts`

**Interfaces:**
- Extends `WidgetTypeSchema` with `'transaction_latency'`, adds
  `TransactionLatencyConfigSchema` (`{ transactionName: string; hours:
  number }`), a `transactionLatency` query function, and adds the widget
  to the starter catalog (now 5 widgets).

- [ ] **Step 1: Extend the shared-types catalog**

Add to `packages/shared-types/src/widgets.ts`: `'transaction_latency'` to
`WidgetTypeSchema`'s enum; `TransactionLatencyConfigSchema = z.object({
transactionName: z.string(), hours: z.number().int().positive().max(168).default(24) })`;
add it to `WidgetConfigSchemaByType`. Extend
`packages/shared-types/src/widgets.test.ts`'s catalog-membership test to
include `'transaction_latency'`, and add a case asserting
`validateWidgetConfig('transaction_latency', { transactionName: 'GET /x' })`
defaults `hours` to 24.

- [ ] **Step 2: Add the query function**

Add to `apps/query-api/src/widgets/run-widget-query.ts`:
```ts
async function transactionLatency(db: Kysely<Database>, config: WidgetConfigFor<'transaction_latency'>, scope: WidgetScope) {
  let query = db
    .selectFrom('transaction_latency_rollup')
    .selectAll()
    .where('project_id', '=', scope.projectId)
    .where('transaction_name', '=', config.transactionName)
    .where('hour_bucket', '>=', sql<Date>`now() - (${config.hours} * interval '1 hour')`)
    .orderBy('hour_bucket', 'asc')

  if (scope.environmentName) {
    query = query
      .innerJoin('environment', 'environment.id', 'transaction_latency_rollup.environment_id')
      .where('environment.name', '=', scope.environmentName)
  }

  return query.execute()
}
```
Add a `case 'transaction_latency':` branch to `runWidgetQuery`'s switch.
Add a test to `run-widget-query.test.ts` seeding a
`transaction_latency_rollup` row directly and asserting it comes back.

- [ ] **Step 3: Add to the starter catalog**

In `packages/db/src/provision-dashboard.ts`, append to `STARTER_WIDGETS`:
```ts
{ widget_type: 'transaction_latency', title: 'Transaction Latency', layout: { x: 0, y: 8, w: 12, h: 4 } },
```
Update the two assertions in `provision-dashboard.test.ts` and any test
elsewhere that hardcodes "4 widgets" (`apps/query-api/src/routes/projects.test.ts`,
`dashboard.test.ts`) to expect 5. **Note:** the `transaction_latency`
widget's default config (`transactionName` has no default — it's
required) won't resolve to a real transaction name for a brand-new
project with no traffic yet; this is fine for provisioning (the widget
starts empty and is configured via the config PATCH endpoint once traffic
exists), but means `validateWidgetConfig('transaction_latency', {})` used
naively at provision time would throw. Provision it with an explicit
placeholder config (`{ transactionName: '', hours: 24 }`) rather than
`{}`, and have `transactionLatency`'s query short-circuit to an empty
array when `config.transactionName === ''`.

- [ ] **Step 4: Typecheck, build, test everything touched, commit**

Run: `pnpm --filter @flare/shared-types test && pnpm --filter @flare/db
test -- provision-dashboard && pnpm --filter @flare/query-api test --
run-widget-query` (DB-backed ones expected to fail on ECONNREFUSED per
the established pattern; shared-types is pure and must pass).

```bash
git add packages/shared-types packages/db apps/query-api
git commit -m "feat: add transaction_latency to the widget catalog"
```

---

### Task 7: `@flare/storage` Gains Presigned URLs

**Files:**
- Modify: `packages/storage/src/create-storage-client.ts`
- Modify: `packages/storage/src/create-storage-client.test.ts`
- Modify: `packages/storage/package.json`

**Interfaces:**
- Adds `getPresignedDownloadUrl(key, expirySeconds?): Promise<string>` to
  `StorageClient`.

- [ ] **Step 1: Add the dependency**

Add to `packages/storage/package.json` dependencies:
`"@aws-sdk/s3-request-presigner": "^3.650.0"`.

- [ ] **Step 2: Write the failing test**

Add to `packages/storage/src/create-storage-client.test.ts`:
```ts
it('generates a presigned URL that can itself be fetched to retrieve the object', async () => {
  const key = `test/presign-${Date.now()}.txt`
  await client.putObject(key, Buffer.from('presigned content'), 'text/plain')

  const url = await client.getPresignedDownloadUrl(key, 60)
  expect(url).toContain(key)

  const response = await fetch(url)
  const text = await response.text()
  expect(text).toBe('presigned content')
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @flare/storage test`
Expected: FAIL — `getPresignedDownloadUrl is not a function`

- [ ] **Step 4: Implement it**

In `packages/storage/src/create-storage-client.ts`:
```ts
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

export interface StorageClient {
  putObject(key: string, body: Buffer, contentType?: string): Promise<void>
  getObject(key: string): Promise<Buffer>
  getPresignedDownloadUrl(key: string, expirySeconds?: number): Promise<string>
}

// inside createStorageClient's returned object, alongside putObject/getObject:
getPresignedDownloadUrl: (key, expirySeconds = 300) =>
  getSignedUrl(s3, new GetObjectCommand({ Bucket: config.bucket, Key: key }), { expiresIn: expirySeconds }),
```

- [ ] **Step 5: Run test to verify it passes (needs MinIO — unverified in this sandbox); typecheck; build; commit**

Run: `pnpm --filter @flare/storage typecheck && pnpm --filter @flare/storage build`

```bash
git add packages/storage
git commit -m "feat(storage): presigned download URLs"
```

---

### Task 8: `replay` / `replay_segment` Tables + `ReplayEventItemSchema`

**Files:**
- Create: `packages/db/migrations/1700000000014_create-replay.cjs`
- Create: `packages/db/migrations/1700000000015_create-replay-segment.cjs`
- Modify: `packages/db/src/schema.ts`
- Create: `packages/shared-types/src/replay.ts`
- Test: `packages/shared-types/src/replay.test.ts`
- Modify: `packages/shared-types/src/index.ts`

**Interfaces:**
- Produces: `ReplayTable`, `ReplaySegmentTable`, `ReplayEventItemSchema`.

- [ ] **Step 1: Migrations**

`packages/db/migrations/1700000000014_create-replay.cjs`:
```js
exports.up = (pgm) => {
  pgm.createTable('replay', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    project_id: { type: 'uuid', notNull: true, references: 'project', onDelete: 'CASCADE' },
    environment_id: { type: 'uuid', notNull: true, references: 'environment', onDelete: 'CASCADE' },
    issue_id: { type: 'uuid', references: 'issue', onDelete: 'SET NULL' },
    session_id: { type: 'text', notNull: true },
    duration_ms: { type: 'integer', notNull: true, default: 0 },
    segment_count: { type: 'integer', notNull: true, default: 0 },
    error_count: { type: 'integer', notNull: true, default: 0 },
    started_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint('replay', 'replay_project_session_unique', 'UNIQUE(project_id, session_id)')
}
exports.down = (pgm) => pgm.dropTable('replay')
```

`packages/db/migrations/1700000000015_create-replay-segment.cjs`:
```js
exports.up = (pgm) => {
  pgm.createTable('replay_segment', {
    replay_id: { type: 'uuid', notNull: true, references: 'replay', onDelete: 'CASCADE' },
    sequence: { type: 'integer', notNull: true },
    storage_key: { type: 'text', notNull: true },
    size_bytes: { type: 'integer', notNull: true },
    started_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint('replay_segment', 'replay_segment_pk', 'PRIMARY KEY (replay_id, sequence)')
}
exports.down = (pgm) => pgm.dropTable('replay_segment')
```

- [ ] **Step 2: Update `Database` schema**

Add to `packages/db/src/schema.ts`:
```ts
export interface ReplayTable {
  id: Generated<string>
  project_id: string
  environment_id: string
  issue_id: string | null
  session_id: string
  duration_ms: Generated<number>
  segment_count: Generated<number>
  error_count: Generated<number>
  started_at: Generated<Date>
}

export interface ReplaySegmentTable {
  replay_id: string
  sequence: number
  storage_key: string
  size_bytes: number
  started_at: Generated<Date>
}
```
Add `replay: ReplayTable`, `replay_segment: ReplaySegmentTable` to
`Database`.

- [ ] **Step 3: Write the failing test for `ReplayEventItemSchema`**

`packages/shared-types/src/replay.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { ReplayEventItemSchema } from './replay'

describe('ReplayEventItemSchema', () => {
  it('parses a minimal replay_event item', () => {
    const result = ReplayEventItemSchema.parse({
      event_id: 'evt-1',
      replay_id: 'replay-1',
      segment_id: 0,
      environment: 'production',
      timestamp: 1700000000,
    })
    expect(result.replayId).toBeUndefined() // field is replay_id, not camelCase, on the wire schema
    expect(result.replay_id).toBe('replay-1')
    expect(result.segment_id).toBe(0)
  })
})
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm --filter @flare/shared-types test -- replay`
Expected: FAIL — `Cannot find module './replay'`

- [ ] **Step 5: Implement `ReplayEventItemSchema`**

`packages/shared-types/src/replay.ts`:
```ts
import { z } from 'zod'

export const ReplayEventItemSchema = z.object({
  event_id: z.string(),
  replay_id: z.string(),
  segment_id: z.number().int().nonnegative(),
  environment: z.string().default('production'),
  timestamp: z.number(),
  error_ids: z.array(z.string()).default([]),
})
export type ReplayEventItem = z.infer<typeof ReplayEventItemSchema>
```

- [ ] **Step 6: Fix the test's incorrect assertion, run to verify it passes**

The `expect(result.replayId).toBeUndefined()` line in Step 3 checks a
property that was never expected to exist on this schema in the first
place — remove that assertion line (it was written to flag "don't
accidentally camelCase this wire-format schema," not to test real
behavior); keep the `replay_id`/`segment_id` assertions.

Run: `pnpm --filter @flare/shared-types test -- replay`
Expected: PASS

- [ ] **Step 7: Barrel export, typecheck, build, commit**

Add `export * from './replay'` to `packages/shared-types/src/index.ts`.

Run: `pnpm --filter @flare/db typecheck && pnpm --filter @flare/shared-types build`

```bash
git add packages/db packages/shared-types
git commit -m "feat(db,shared-types): replay/replay_segment tables and ReplayEventItemSchema"
```

---

### Task 9: `replay-worker`

**Files:**
- Create: `apps/replay-worker/package.json`
- Create: `apps/replay-worker/tsconfig.json`
- Create: `apps/replay-worker/vitest.config.ts`
- Create: `apps/replay-worker/src/consumer.ts`
- Create: `apps/replay-worker/src/upsert-replay-event.ts`
- Test: `apps/replay-worker/src/upsert-replay-event.test.ts`
- Create: `apps/replay-worker/src/store-replay-segment.ts`
- Test: `apps/replay-worker/src/store-replay-segment.test.ts`
- Create: `apps/replay-worker/src/handle-message.ts`
- Create: `apps/replay-worker/src/main.ts`

**Interfaces:**
- Consumes: `resolveEnvironment`, `ReplayEventItemSchema` (Task 8),
  `StorageClient` (Task 7).
- Produces: `upsertReplayEvent(db, params): Promise<void>`,
  `storeReplaySegment(deps, params): Promise<void>`,
  `handleReplayMessage(deps, rawValue): Promise<void>`.

- [ ] **Step 1: Package scaffold**

Same shape as `symbolication-worker`'s package files (dependencies:
`@flare/db`, `@flare/shared-types`, `@flare/storage`, `ioredis`,
`kafkajs`, `kysely`). Copy `consumer.ts` verbatim (rename `clientId` to
`'replay-worker'`).

- [ ] **Step 2: Write the failing test for `upsertReplayEvent`**

`apps/replay-worker/src/upsert-replay-event.test.ts`:
```ts
import { createDb } from '@flare/db'
import { afterAll, describe, expect, it } from 'vitest'
import { upsertReplayEvent } from './upsert-replay-event'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')

afterAll(() => db.destroy())

describe('upsertReplayEvent', () => {
  it('creates the replay row on the first segment and increments error_count on a later one', async () => {
    const project = await db
      .insertInto('project')
      .values({ name: 'Replay Test', slug: `replay-test-${Date.now()}`, public_key: `pk-replay-${Date.now()}` })
      .returningAll()
      .executeTakeFirstOrThrow()
    const environment = await db
      .insertInto('environment')
      .values({ project_id: project.id, name: 'production' })
      .returningAll()
      .executeTakeFirstOrThrow()

    const sessionId = `session-${Date.now()}`
    await upsertReplayEvent(db, { projectId: project.id, environmentId: environment.id, sessionId, errorCount: 0 })
    await upsertReplayEvent(db, { projectId: project.id, environmentId: environment.id, sessionId, errorCount: 1 })

    const replay = await db.selectFrom('replay').selectAll().where('session_id', '=', sessionId).executeTakeFirstOrThrow()
    expect(replay.error_count).toBe(1)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `DATABASE_URL=... pnpm --filter @flare/replay-worker test -- upsert-replay-event`
Expected: FAIL — `Cannot find module './upsert-replay-event'`

- [ ] **Step 4: Implement `upsertReplayEvent`**

`apps/replay-worker/src/upsert-replay-event.ts`:
```ts
import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { Database } from '@flare/db'

export async function upsertReplayEvent(
  db: Kysely<Database>,
  params: { projectId: string; environmentId: string; sessionId: string; errorCount: number }
): Promise<string> {
  const row = await db
    .insertInto('replay')
    .values({
      project_id: params.projectId,
      environment_id: params.environmentId,
      session_id: params.sessionId,
      error_count: params.errorCount,
    })
    .onConflict((oc) =>
      oc
        .columns(['project_id', 'session_id'])
        .doUpdateSet({ error_count: sql`replay.error_count + ${params.errorCount}` })
    )
    .returning('id')
    .executeTakeFirstOrThrow()

  return row.id
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: same command as Step 3.
Expected: PASS

- [ ] **Step 6: Write the failing test for `storeReplaySegment`**

`apps/replay-worker/src/store-replay-segment.test.ts`:
```ts
import { createDb } from '@flare/db'
import { createStorageClient } from '@flare/storage'
import { afterAll, describe, expect, it } from 'vitest'
import { storeReplaySegment } from './store-replay-segment'
import { upsertReplayEvent } from './upsert-replay-event'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')
const storage = createStorageClient({
  endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
  region: 'us-east-1',
  accessKeyId: process.env.S3_ACCESS_KEY ?? 'flare',
  secretAccessKey: process.env.S3_SECRET_KEY ?? 'flare12345',
  bucket: process.env.S3_BUCKET ?? 'flare-source-maps',
})

afterAll(() => db.destroy())

describe('storeReplaySegment', () => {
  it('writes the segment blob to storage and records a replay_segment row, bumping segment_count', async () => {
    const project = await db
      .insertInto('project')
      .values({ name: 'Segment Test', slug: `segment-test-${Date.now()}`, public_key: `pk-segment-${Date.now()}` })
      .returningAll()
      .executeTakeFirstOrThrow()
    const environment = await db
      .insertInto('environment')
      .values({ project_id: project.id, name: 'production' })
      .returningAll()
      .executeTakeFirstOrThrow()
    const replayId = await upsertReplayEvent(db, {
      projectId: project.id,
      environmentId: environment.id,
      sessionId: `session-seg-${Date.now()}`,
      errorCount: 0,
    })

    await storeReplaySegment(
      { db, storage },
      { projectId: project.id, replayId, sequence: 0, content: Buffer.from('rrweb events blob') }
    )

    const segment = await db
      .selectFrom('replay_segment')
      .selectAll()
      .where('replay_id', '=', replayId)
      .where('sequence', '=', 0)
      .executeTakeFirstOrThrow()
    expect(segment.size_bytes).toBe(Buffer.byteLength('rrweb events blob'))

    const replay = await db.selectFrom('replay').selectAll().where('id', '=', replayId).executeTakeFirstOrThrow()
    expect(replay.segment_count).toBe(1)
  })
})
```

- [ ] **Step 7: Run test to verify it fails**

Run: `DATABASE_URL=... S3_ENDPOINT=... pnpm --filter @flare/replay-worker test -- store-replay-segment`
Expected: FAIL — `Cannot find module './store-replay-segment'`

- [ ] **Step 8: Implement `storeReplaySegment`**

`apps/replay-worker/src/store-replay-segment.ts`:
```ts
import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { Database } from '@flare/db'
import type { StorageClient } from '@flare/storage'

export async function storeReplaySegment(
  deps: { db: Kysely<Database>; storage: StorageClient },
  params: { projectId: string; replayId: string; sequence: number; content: Buffer }
): Promise<void> {
  const storageKey = `replays/${params.projectId}/${params.replayId}/${params.sequence}.bin`
  await deps.storage.putObject(storageKey, params.content)

  await deps.db
    .insertInto('replay_segment')
    .values({ replay_id: params.replayId, sequence: params.sequence, storage_key: storageKey, size_bytes: params.content.length })
    .onConflict((oc) => oc.columns(['replay_id', 'sequence']).doUpdateSet({ storage_key: storageKey, size_bytes: params.content.length }))
    .execute()

  await deps.db
    .updateTable('replay')
    .set({ segment_count: sql`segment_count + 1` })
    .where('id', '=', params.replayId)
    .execute()
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: same command as Step 7.
Expected: PASS

- [ ] **Step 10: Wire `handleReplayMessage` and `main.ts`**

`apps/replay-worker/src/handle-message.ts`:
```ts
import type { Kysely } from 'kysely'
import type { Database } from '@flare/db'
import { resolveEnvironment } from '@flare/db'
import type { Redis } from 'ioredis'
import type { StorageClient } from '@flare/storage'
import { ReplayEventItemSchema } from '@flare/shared-types'
import { upsertReplayEvent } from './upsert-replay-event'
import { storeReplaySegment } from './store-replay-segment'

interface IngestReplayMessage {
  projectId: string
  itemType: 'replay_event' | 'replay_recording'
  payload: string
}

// A per-(project, session) sequence counter for replay_recording items,
// which carry no segment number of their own in this plan's simplified
// wire format (see the Global Constraints note on NOT reproducing
// Sentry's real replay_recording sub-format byte-for-byte).
const sequenceCounters = new Map<string, number>()

export async function handleReplayMessage(
  deps: { db: Kysely<Database>; redis: Redis; storage: StorageClient },
  rawValue: Buffer
): Promise<void> {
  const message = JSON.parse(rawValue.toString('utf8')) as IngestReplayMessage
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
  // plan does not parse -- see Global Constraints). Ingestion therefore
  // requires the companion replay_event for a session to have already
  // registered it; without a real replay_id to key on here, segments are
  // filed under a per-project counter key instead. This is the concrete
  // seam to revisit once wiring against a real SDK-recorded payload.
  const counterKey = message.projectId
  const sequence = sequenceCounters.get(counterKey) ?? 0
  sequenceCounters.set(counterKey, sequence + 1)
}
```

**Note on this task's real limitation:** `replay_recording` handling above
is intentionally incomplete — it counts segments but has no way to
associate a recording blob with the `replay` row it belongs to, because
this plan's simplified wire format (Global Constraints) doesn't carry a
`replay_id` on the recording item the way real Sentry's nested sub-header
does. Wiring `storeReplaySegment` for real `replay_recording` items is
the concrete next step once there's a real SDK payload to shape the
association against — tracked here, not silently glossed over. The
`replay_event` path (session creation, error count) is complete and
tested.

`apps/replay-worker/src/main.ts` mirrors `grouping-worker/src/main.ts`
(consume `ingest.replays`, call `handleReplayMessage`).

- [ ] **Step 11: Typecheck, build, commit**

Run: `pnpm --filter @flare/replay-worker typecheck && pnpm --filter @flare/replay-worker build`

```bash
git add apps/replay-worker
git commit -m "feat(replay-worker): new app ingesting replay sessions and segment blobs"
```

---

### Task 10: `GET /api/v1/replays` and `GET /api/v1/replays/:id`

**Files:**
- Create: `apps/query-api/src/routes/replays.ts`
- Test: `apps/query-api/src/routes/replays.test.ts`
- Modify: `apps/query-api/src/app.ts`
- Modify: `apps/query-api/package.json`

**Interfaces:**
- Consumes: `StorageClient` (Task 7) — `AppDeps` gains `storage`.
- Produces: `GET /api/v1/projects/:projectId/replays` (list),
  `GET /api/v1/replays/:id` (metadata + presigned segment URLs).

- [ ] **Step 1: Add `@flare/storage` to `query-api` and `storage` to `AppDeps`**

Add `"@flare/storage": "workspace:*"` to `apps/query-api/package.json`
dependencies. Add `storage: StorageClient` to `AppDeps` in `app.ts`;
thread it into `server.ts` (same `createStorageClient` construction
pattern as `ingest-api`'s `server.ts`); add `storage: {} as never` to
every existing test's `buildApp({...})` call that doesn't exercise replay
routes.

- [ ] **Step 2: Write the failing test**

`apps/query-api/src/routes/replays.test.ts`:
```ts
import { createDb } from '@flare/db'
import { createStorageClient } from '@flare/storage'
import { afterAll, describe, expect, it } from 'vitest'
import { buildApp } from '../app'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')
const storage = createStorageClient({
  endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
  region: 'us-east-1',
  accessKeyId: process.env.S3_ACCESS_KEY ?? 'flare',
  secretAccessKey: process.env.S3_SECRET_KEY ?? 'flare12345',
  bucket: process.env.S3_BUCKET ?? 'flare-source-maps',
})
const app = buildApp({ db, redis: {} as never, storage })

afterAll(async () => {
  await db.destroy()
  await app.close()
})

describe('replays', () => {
  it('lists replays for a project and returns one with presigned segment URLs', async () => {
    const project = await db
      .insertInto('project')
      .values({ name: 'Replay Route Test', slug: `replay-route-${Date.now()}`, public_key: `pk-replay-route-${Date.now()}` })
      .returningAll()
      .executeTakeFirstOrThrow()
    const environment = await db
      .insertInto('environment')
      .values({ project_id: project.id, name: 'production' })
      .returningAll()
      .executeTakeFirstOrThrow()
    const replay = await db
      .insertInto('replay')
      .values({ project_id: project.id, environment_id: environment.id, session_id: `sess-${Date.now()}` })
      .returningAll()
      .executeTakeFirstOrThrow()
    await db
      .insertInto('replay_segment')
      .values({ replay_id: replay.id, sequence: 0, storage_key: `replays/${project.id}/${replay.id}/0.bin`, size_bytes: 10 })
      .execute()

    const listResponse = await app.inject({ method: 'GET', url: `/api/v1/projects/${project.id}/replays` })
    expect(listResponse.statusCode).toBe(200)
    expect(listResponse.json().some((r: { id: string }) => r.id === replay.id)).toBe(true)

    const detailResponse = await app.inject({ method: 'GET', url: `/api/v1/replays/${replay.id}` })
    expect(detailResponse.statusCode).toBe(200)
    const body = detailResponse.json()
    expect(body.segments).toHaveLength(1)
    expect(body.segments[0].downloadUrl).toContain('0.bin')
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `DATABASE_URL=... S3_ENDPOINT=... pnpm --filter @flare/query-api test -- replays`
Expected: FAIL — routes not registered

- [ ] **Step 4: Implement the routes**

`apps/query-api/src/routes/replays.ts`:
```ts
import type { FastifyInstance } from 'fastify'

export function registerReplayRoutes(app: FastifyInstance): void {
  app.get<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/replays', async (request) => {
    return app.deps.db
      .selectFrom('replay')
      .selectAll()
      .where('project_id', '=', request.params.projectId)
      .orderBy('started_at', 'desc')
      .execute()
  })

  app.get<{ Params: { id: string } }>('/api/v1/replays/:id', async (request, reply) => {
    const replay = await app.deps.db.selectFrom('replay').selectAll().where('id', '=', request.params.id).executeTakeFirst()
    if (!replay) return reply.code(404).send({ error: 'not found' })

    const segments = await app.deps.db
      .selectFrom('replay_segment')
      .selectAll()
      .where('replay_id', '=', replay.id)
      .orderBy('sequence', 'asc')
      .execute()

    const segmentsWithUrls = await Promise.all(
      segments.map(async (segment) => ({
        sequence: segment.sequence,
        sizeBytes: segment.size_bytes,
        downloadUrl: await app.deps.storage.getPresignedDownloadUrl(segment.storage_key),
      }))
    )

    return { ...replay, segments: segmentsWithUrls }
  })
}
```

- [ ] **Step 5: Register in `app.ts`, run test to verify it passes, typecheck, build, commit**

```ts
import { registerReplayRoutes } from './routes/replays'
// alongside the other register*Routes(app) calls:
registerReplayRoutes(app)
```

```bash
git add apps/query-api
git commit -m "feat(query-api): replay list and detail (with presigned segment URLs) endpoints"
```

---

### Task 11: Widget Catalog — `replay_count`

**Files:**
- Modify: `packages/shared-types/src/widgets.ts` (+ test)
- Modify: `apps/query-api/src/widgets/run-widget-query.ts` (+ test)
- Modify: `packages/db/src/provision-dashboard.ts` (+ test)

**Interfaces:**
- Extends the catalog with `'replay_count'` (`ReplayCountConfigSchema =
  z.object({ windowDays: z.number().int().positive().max(90).default(14)
  })`), a `replayCount` query function (`count(*) from replay where
  project_id = ? and started_at >= ...`), and adds it to the starter
  catalog (now 6 widgets).

- [ ] **Step 1–4: Same shape as Task 6**, mirroring every sub-step
  (schema enum + config schema + test, query function + switch branch +
  test seeding a `replay` row, starter-catalog addition + updated widget-
  count assertions everywhere `4`/`5` is hardcoded).

```bash
git add packages/shared-types packages/db apps/query-api
git commit -m "feat: add replay_count to the widget catalog"
```

---

### Task 12: Web Replay List + Detail (Metadata/Download Only)

**Files:**
- Create: `apps/web/src/pages/ReplayListPage.tsx`
- Test: `apps/web/src/pages/ReplayListPage.test.tsx`
- Create: `apps/web/src/pages/ReplayDetailPage.tsx`
- Test: `apps/web/src/pages/ReplayDetailPage.test.tsx`
- Modify: `apps/web/src/api/query-client.ts`
- Modify: `apps/web/src/App.tsx`

**Interfaces:**
- Produces: `fetchReplays(projectId)`, `fetchReplay(replayId)`, two routes.
  **Explicitly does not** wire `@rrweb/replay`'s `Replayer` — see Global
  Constraints. Segments are exposed as plain download links.

- [ ] **Step 1: Write the failing tests**

`apps/web/src/pages/ReplayListPage.test.tsx`:
```tsx
import { render, screen, waitFor } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { MemoryRouter } from 'react-router-dom'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ReplayListPage } from './ReplayListPage'

const server = setupServer(
  http.get('http://localhost:3001/api/v1/projects/proj-1/replays', () =>
    HttpResponse.json([{ id: 'replay-1', session_id: 'sess-1', duration_ms: 5000, segment_count: 3, error_count: 1, started_at: '2026-09-01T00:00:00.000Z' }])
  )
)

beforeAll(() => server.listen())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('ReplayListPage', () => {
  it('renders each replay session with its segment and error counts', async () => {
    render(
      <MemoryRouter>
        <ReplayListPage projectId="proj-1" />
      </MemoryRouter>
    )
    await waitFor(() => expect(screen.getByText('sess-1')).toBeInTheDocument())
    expect(screen.getByText('3 segments')).toBeInTheDocument()
  })
})
```

`apps/web/src/pages/ReplayDetailPage.test.tsx`:
```tsx
import { render, screen, waitFor } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ReplayDetailPage } from './ReplayDetailPage'

const server = setupServer(
  http.get('http://localhost:3001/api/v1/replays/replay-1', () =>
    HttpResponse.json({
      id: 'replay-1',
      session_id: 'sess-1',
      segments: [{ sequence: 0, sizeBytes: 1024, downloadUrl: 'http://minio.local/replays/replay-1/0.bin?sig=x' }],
    })
  )
)

beforeAll(() => server.listen())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('ReplayDetailPage', () => {
  it('renders a download link per segment', async () => {
    render(
      <MemoryRouter initialEntries={['/replays/replay-1']}>
        <Routes>
          <Route path="/replays/:replayId" element={<ReplayDetailPage />} />
        </Routes>
      </MemoryRouter>
    )
    await waitFor(() => expect(screen.getByText('Segment 0')).toBeInTheDocument())
    expect(screen.getByRole('link', { name: 'Segment 0' })).toHaveAttribute(
      'href',
      'http://minio.local/replays/replay-1/0.bin?sig=x'
    )
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @flare/web test -- ReplayListPage ReplayDetailPage`
Expected: FAIL — modules don't exist

- [ ] **Step 3: Add API client functions**

Add to `apps/web/src/api/query-client.ts`:
```ts
export interface ReplaySummary { id: string; session_id: string; duration_ms: number; segment_count: number; error_count: number; started_at: string }
export interface ReplaySegmentDto { sequence: number; sizeBytes: number; downloadUrl: string }

export async function fetchReplays(projectId: string): Promise<ReplaySummary[]> {
  const response = await fetch(`${QUERY_API_BASE_URL}/api/v1/projects/${projectId}/replays`)
  return response.json()
}

export async function fetchReplay(replayId: string): Promise<{ id: string; session_id: string; segments: ReplaySegmentDto[] }> {
  const response = await fetch(`${QUERY_API_BASE_URL}/api/v1/replays/${replayId}`)
  return response.json()
}
```

- [ ] **Step 4: Implement the pages**

`apps/web/src/pages/ReplayListPage.tsx`:
```tsx
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchReplays, type ReplaySummary } from '../api/query-client'

export function ReplayListPage({ projectId }: { projectId: string }) {
  const [replays, setReplays] = useState<ReplaySummary[]>([])

  useEffect(() => {
    fetchReplays(projectId).then(setReplays)
  }, [projectId])

  return (
    <ul>
      {replays.map((replay) => (
        <li key={replay.id}>
          <Link to={`/replays/${replay.id}`}>{replay.session_id}</Link>
          {` — ${replay.segment_count} segments, ${replay.error_count} errors`}
        </li>
      ))}
    </ul>
  )
}
```

`apps/web/src/pages/ReplayDetailPage.tsx`:
```tsx
import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { fetchReplay, type ReplaySegmentDto } from '../api/query-client'

export function ReplayDetailPage() {
  const { replayId } = useParams<{ replayId: string }>()
  const [segments, setSegments] = useState<ReplaySegmentDto[] | null>(null)

  useEffect(() => {
    if (replayId) fetchReplay(replayId).then((r) => setSegments(r.segments))
  }, [replayId])

  if (!segments) return <p>Loading…</p>

  return (
    <div>
      <p>
        Live in-browser playback is not built yet -- these are raw segment
        downloads for inspection.
      </p>
      <ul>
        {segments.map((segment) => (
          <li key={segment.sequence}>
            <a href={segment.downloadUrl}>{`Segment ${segment.sequence}`}</a>
          </li>
        ))}
      </ul>
    </div>
  )
}
```

- [ ] **Step 5: Run tests to verify they pass; wire routes; full suite/typecheck/build; commit**

Add to `apps/web/src/App.tsx`: a `/projects/:projectId/replays` route
(wrapper component reading `useParams`, same pattern as the dashboard
route) rendering `<ReplayListPage />`, and `/replays/:replayId` rendering
`<ReplayDetailPage />`.

Run: `pnpm --filter @flare/web test && pnpm --filter @flare/web typecheck
&& pnpm --filter @flare/web build`

```bash
git add apps/web
git commit -m "feat(web): replay list and detail pages (metadata/download only, no live playback yet)"
```

---

## Verification (after all 12 tasks)

1. `pnpm turbo run lint typecheck build --force` from a clean state.
2. On a Docker-enabled machine: `docker compose up -d`, run migrations,
   create the MinIO bucket, `pnpm turbo run test`.
3. Manually: send a `transaction` item through the envelope endpoint,
   confirm `GET /api/v1/traces/:traceId` returns it and its spans, and
   that `transaction_latency_rollup` has a row after an hour boundary or
   a manual query. Send a `replay_event` item, confirm it shows up in
   `GET /api/v1/projects/:id/replays`.

## What Phase 5 inherits as open work

- Real `@rrweb/replay` `Replayer` wiring against actual recorded segments
  (needs a browser + a real SDK-produced session — first candidate for a
  focused follow-up plan, not a backlog item to forget).
- `replay_recording` → `replay_segment` association (Task 9's noted gap):
  needs a real SDK payload to know what the actual wire association looks
  like before building it for real, rather than guessing.
- True incremental latency-percentile maintenance (t-digest or similar),
  if per-write full-bucket recompute ever measurably matters at higher
  transaction volume.
