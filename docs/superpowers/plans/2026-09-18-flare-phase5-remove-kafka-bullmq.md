# Flare Phase 5 (Remove Kafka, Adopt BullMQ + Durable Raw-Envelope Archive) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove Kafka entirely. Replace the four `ingest.*`/`work.*` topics
with BullMQ queues on the Redis Flare already runs. Recover the one
property Kafka's retention gave us that a job queue doesn't — durable,
replayable history — by archiving the raw envelope bytes to Postgres
*before* enqueueing, decoupling "durability" from "work dispatch."

**Architecture:** `ingest-api` parses the envelope (unchanged), archives
the raw bytes to a new `raw_envelope` table, then enqueues each item to a
BullMQ queue instead of a Kafka topic (`ingest.errors`,
`ingest.transactions`, `ingest.replays` — same names, same one-queue-per-
concern shape as the topics they replace, so `grouping-worker`/
`transaction-worker`/`replay-worker`/`symbolication-worker` keep their
existing separation and independent concurrency). Each worker becomes a
BullMQ `Worker` instead of a KafkaJS consumer. A new backfill script reads
`raw_envelope` and re-publishes to the queues for any project/time range —
that's the replay capability, decoupled from Redis's own retention.

**Tech Stack:** removes `kafkajs` everywhere it appears. Adds `bullmq` to
every app that currently depends on `kafkajs` (`ingest-api`,
`grouping-worker`, `transaction-worker`, `replay-worker`,
`symbolication-worker`). No other new dependencies — `ioredis` is already
in use everywhere BullMQ needs it.

**Spec:** [docs/superpowers/plans/flare-technical-plan.md](../flare-technical-plan.md)
is the original architecture plan and is **not** rewritten in place — this
plan supersedes its Kafka-specific sections (the streaming/queue fixed
decision, the pipeline topic design in §4, and the deployment notes on
running Kafka/Strimzi in §8). Read this plan as the current source of
truth for the ingest→queue→worker pipeline; the original doc's reasoning
on *why* a queue/pipeline shape exists at all (thin ingest hot path,
per-concern worker separation, idempotent upserts) still holds and isn't
being revisited.

## Global Constraints

Same as prior phases, plus:
- **BullMQ's Redis connection must be constructed with `maxRetriesPerRequest:
  null`** — this is a documented BullMQ requirement (it issues blocking
  commands that don't tolerate the default retry behavior). Every app
  constructs a **second, dedicated** `ioredis` connection for BullMQ,
  separate from the existing `redis` client used for
  `resolveEnvironment`/`resolveOrCreateRelease`/rate-limiting/caching —
  sharing one connection between BullMQ's blocking commands and ordinary
  cache reads/writes risks one starving the other. Two small `ioredis`
  clients per process, not one shared.
- **Queue names mirror the topic names they replace exactly**
  (`ingest.errors`, `ingest.transactions`, `ingest.replays`,
  `work.symbolication`) — this keeps the diff in every route/handler file
  to "swap the transport call," not "redesign the routing," and keeps this
  plan's git history honest about what changed and what didn't.
- **Idempotency stays belt-and-suspenders.** The existing DB-level
  `ON CONFLICT` upserts (grouping, transaction, replay) are the real
  correctness guarantee and are not touched by this plan. On top of that,
  every job that has a natural stable key (`projectId:eventId` for error
  and transaction items) gets `jobId` set to that key at enqueue time —
  BullMQ treats re-adding a job with an existing id as a no-op, so a
  retried HTTP request from an SDK gets deduped before it even reaches a
  worker, not just at the DB layer.
- **Retry/backoff is new, not a port of existing behavior.** Kafka gave
  Flare no automatic retry at all — a failed `eachMessage` handler in the
  old code just... didn't retry. Every queue producer in this plan sets
  `attempts: 5, backoff: { type: 'exponential', delay: 1000 }`. This is a
  real improvement, called out so it isn't mistaken for a like-for-like
  port.
- **No separate named dead-letter queue in this plan.** BullMQ retains
  failed jobs (post-`attempts`-exhaustion) in the queue's own failed set,
  inspectable via `queue.getFailed()`. A dedicated `*.dead` queue
  (mirroring geniusDebug's pattern) is a clean, cheap follow-up if a
  queryable cross-queue dead-letter view is ever actually needed — not
  built speculatively here.
- **`raw_envelope` is not partitioned in this plan.** Same ruling as
  `event` in Phase 1/2: `pg_partman`'s exact API can't be verified without
  a running instance in this sandbox, so this table is a plain table for
  now. Retention for it rides along with the already-planned Phase 7
  hardening work, not decided here.

---

### Task 1: `raw_envelope` Table + `archiveRawEnvelope`

**Files:**
- Create: `packages/db/migrations/1700000000016_create-raw-envelope.cjs`
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/src/archive-raw-envelope.ts`
- Test: `packages/db/src/archive-raw-envelope.test.ts`
- Modify: `packages/db/src/index.ts`

**Interfaces:**
- Produces: `RawEnvelopeTable`, `archiveRawEnvelope(db, params: { projectId:
  string; eventId: string | null; rawBytes: Buffer }): Promise<string>`
  (returns the new row's id) — consumed by Task 2 (`ingest-api`) and Task 8
  (the backfill script).

- [ ] **Step 1: Migration**

```js
exports.up = (pgm) => {
  pgm.createTable('raw_envelope', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    project_id: { type: 'uuid', notNull: true, references: 'project', onDelete: 'CASCADE' },
    event_id: { type: 'text' },
    raw_bytes: { type: 'bytea', notNull: true },
    received_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.createIndex('raw_envelope', ['project_id', 'received_at'])
}
exports.down = (pgm) => pgm.dropTable('raw_envelope')
```

- [ ] **Step 2: Update `Database` schema**

Add to `packages/db/src/schema.ts`:
```ts
export interface RawEnvelopeTable {
  id: Generated<string>
  project_id: string
  event_id: string | null
  raw_bytes: Buffer
  received_at: Generated<Date>
}
```
Add `raw_envelope: RawEnvelopeTable` to `Database`.

- [ ] **Step 3: Write the failing test**

`packages/db/src/archive-raw-envelope.test.ts`:
```ts
import { createDb } from './create-db'
import { archiveRawEnvelope } from './archive-raw-envelope'
import { afterAll, describe, expect, it } from 'vitest'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')

afterAll(() => db.destroy())

describe('archiveRawEnvelope', () => {
  it('stores the raw bytes verbatim, retrievable byte-for-byte', async () => {
    const project = await db
      .insertInto('project')
      .values({ name: 'Archive Test', slug: `archive-test-${Date.now()}`, public_key: `pk-archive-${Date.now()}` })
      .returningAll()
      .executeTakeFirstOrThrow()

    const rawBytes = Buffer.from('envelope-header\n{"type":"event"}\n{"event_id":"abc"}\n')
    const id = await archiveRawEnvelope(db, { projectId: project.id, eventId: 'abc', rawBytes })

    const row = await db.selectFrom('raw_envelope').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
    expect(Buffer.from(row.raw_bytes).equals(rawBytes)).toBe(true)
    expect(row.event_id).toBe('abc')
  })
})
```

- [ ] **Step 4: Run test to verify it fails**

Run: `DATABASE_URL=... pnpm --filter @flare/db test -- archive-raw-envelope`
Expected: FAIL — `Cannot find module './archive-raw-envelope'`

- [ ] **Step 5: Implement it**

`packages/db/src/archive-raw-envelope.ts`:
```ts
import type { Kysely } from 'kysely'
import type { Database } from './schema'

export async function archiveRawEnvelope(
  db: Kysely<Database>,
  params: { projectId: string; eventId: string | null; rawBytes: Buffer }
): Promise<string> {
  const row = await db
    .insertInto('raw_envelope')
    .values({ project_id: params.projectId, event_id: params.eventId, raw_bytes: params.rawBytes })
    .returning('id')
    .executeTakeFirstOrThrow()
  return row.id
}
```

- [ ] **Step 6: Run test to verify it passes; barrel export; typecheck; build; commit**

Add `export * from './archive-raw-envelope'` to `packages/db/src/index.ts`.

Run: `pnpm --filter @flare/db typecheck && pnpm --filter @flare/db build`

```bash
git add packages/db
git commit -m "feat(db): raw_envelope durable archive table and archiveRawEnvelope"
```

---

### Task 2: `ingest-api` — Archive, Then Enqueue via BullMQ

**Files:**
- Delete: `apps/ingest-api/src/kafka/producer.ts`
- Create: `apps/ingest-api/src/queue/producer.ts`
- Modify: `apps/ingest-api/src/app.ts`
- Modify: `apps/ingest-api/src/server.ts`
- Modify: `apps/ingest-api/src/routes/envelope.ts`
- Modify: `apps/ingest-api/src/routes/envelope.test.ts`
- Modify: `apps/ingest-api/src/routes/releases.test.ts`
- Modify: `apps/ingest-api/src/app.test.ts`
- Modify: `apps/ingest-api/package.json`

**Interfaces:**
- Consumes: `archiveRawEnvelope` (Task 1).
- Produces: `QueueProducer` (`{ send(queueName, jobName, data, opts?):
  Promise<void>; close(): Promise<void> }`), `createQueueProducer(connection:
  Redis): QueueProducer` — replaces `EventProducer`/`createKafkaProducer`.
  `AppDeps.producer` keeps its name and shape at the call sites in
  `envelope.ts` (`producer.send(topic, key, value)` →
  `producer.send(queueName, jobName, data, opts)`), minimizing the diff.

- [ ] **Step 1: Package swap**

In `apps/ingest-api/package.json`, remove `"kafkajs"`, add `"bullmq":
"^5.28.0"`.

- [ ] **Step 2: Implement the BullMQ producer wrapper**

`apps/ingest-api/src/queue/producer.ts`:
```ts
import { Queue, type JobsOptions } from 'bullmq'
import type { Redis } from 'ioredis'

export interface QueueProducer {
  send(queueName: string, jobName: string, data: unknown, opts?: JobsOptions): Promise<void>
  close(): Promise<void>
}

export function createQueueProducer(connection: Redis): QueueProducer {
  const queues = new Map<string, Queue>()

  function getQueue(name: string): Queue {
    let queue = queues.get(name)
    if (!queue) {
      queue = new Queue(name, { connection })
      queues.set(name, queue)
    }
    return queue
  }

  return {
    send: async (queueName, jobName, data, opts) => {
      await getQueue(queueName).add(jobName, data, opts)
    },
    close: async () => {
      await Promise.all([...queues.values()].map((queue) => queue.close()))
    },
  }
}
```

- [ ] **Step 3: Update `AppDeps` and archive-then-route in the envelope route**

In `apps/ingest-api/src/app.ts`, replace the `EventProducer` import/type
with `QueueProducer` from `./queue/producer` (the `producer: EventProducer`
field on `AppDeps` becomes `producer: QueueProducer`; everything else in
`app.ts` is unchanged since the field name and route registration don't
change).

In `apps/ingest-api/src/routes/envelope.ts`, archive the raw envelope
immediately after a successful `parseEnvelope`, before the item loop, and
change every `producer.send('ingest.X', key, JSON.stringify(payload))`
call to `producer.send('ingest.X', 'jobName', payload, opts)` — BullMQ
serializes job data itself, so the manual `JSON.stringify` goes away:

```ts
import { archiveRawEnvelope } from '@flare/db'
// ...

const raw = request.body as Buffer
const envelope = parseEnvelope(raw)

await archiveRawEnvelope(db, {
  projectId: project.id,
  eventId: envelope.header.event_id ?? null,
  rawBytes: raw,
})

let lastEventId: string | undefined
for (const item of envelope.items) {
  if (item.header.type === 'event') {
    const parsed = SentryEventItemSchema.parse(JSON.parse(item.payload.toString('utf8')))
    lastEventId = parsed.event_id
    await producer.send(
      'ingest.errors',
      'error',
      { projectId: project.id, event: parsed },
      { jobId: `${project.id}:${parsed.event_id}`, attempts: 5, backoff: { type: 'exponential', delay: 1000 } }
    )
  } else if (item.header.type === 'transaction') {
    const parsed = TransactionItemSchema.parse(JSON.parse(item.payload.toString('utf8')))
    lastEventId = parsed.event_id
    await producer.send(
      'ingest.transactions',
      'transaction',
      { projectId: project.id, event: parsed },
      { jobId: `${project.id}:${parsed.event_id}`, attempts: 5, backoff: { type: 'exponential', delay: 1000 } }
    )
  } else if (item.header.type === 'replay_event' || item.header.type === 'replay_recording') {
    await producer.send(
      'ingest.replays',
      'replay',
      { projectId: project.id, itemType: item.header.type, payload: item.payload.toString('base64') },
      { attempts: 5, backoff: { type: 'exponential', delay: 1000 } }
    )
  }
}
```

The archive call is deliberately unguarded (no try/catch) — if Postgres is
unreachable, the request fails with a 500 (Fastify's default error
handling, same as every other uncaught DB error in this codebase) rather
than silently proceeding without the durability guarantee that's the
entire point of this table. This isn't a new single point of failure:
`resolveProjectByPublicKey`'s cache-miss path already makes ingest
soft-dependent on Postgres today.

- [ ] **Step 4: Update `server.ts`**

Replace `createKafkaProducer((process.env.KAFKA_BROKERS ?? '...').split(','))`
with a second `ioredis` connection plus `createQueueProducer`:
```ts
import Redis from 'ioredis'
import { createQueueProducer } from './queue/producer'

const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379')
const queueConnection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null })
const producer = createQueueProducer(queueConnection)
```
Remove the old `await producer.connect()` call in `main()` — BullMQ's
`Queue` connects lazily via the `ioredis` instance passed in, there's no
separate connect step.

- [ ] **Step 5: Update the tests**

`envelope.test.ts` and `releases.test.ts` both construct a real Kafka
producer/consumer today to assert on published messages. Replace with a
dedicated `ioredis` connection (`maxRetriesPerRequest: null`) and
`createQueueProducer`; assert on a published job by reading it back with a
plain BullMQ `Queue` + `.getJob()` (jobId-based) or by running a throwaway
`Worker` for the target queue and awaiting one job, matching the existing
"subscribe, then trigger, then assert on what arrived" shape but with
BullMQ APIs instead of KafkaJS's `consumer.subscribe`/`consumer.run`.

`app.test.ts`'s stub (`producer: {} as never`) is unaffected — no change
needed there.

- [ ] **Step 6: Typecheck, build, run test suite, commit**

Run: `pnpm --filter @flare/ingest-api typecheck && pnpm --filter
@flare/ingest-api build`. Run the full suite — pure-logic tests
(`parse-envelope`, `parse-sentry-auth-header`, `content-type-parsing`,
`app.test.ts`) must still pass; Redis/Postgres-backed tests are expected
to fail on `ECONNREFUSED` in this Docker-less sandbox, same pattern as
every prior phase.

```bash
git add apps/ingest-api
git commit -m "feat(ingest-api): archive raw envelope to Postgres, enqueue via BullMQ instead of Kafka"
```

---

### Task 3: `grouping-worker` — BullMQ Consumer + Producer

**Files:**
- Delete: `apps/grouping-worker/src/kafka/producer.ts`
- Create: `apps/grouping-worker/src/queue/producer.ts`
- Modify: `apps/grouping-worker/src/consumer.ts`
- Modify: `apps/grouping-worker/src/handle-message.ts`
- Modify: `apps/grouping-worker/src/handle-message.test.ts`
- Modify: `apps/grouping-worker/src/main.ts`
- Modify: `apps/grouping-worker/package.json`

**Interfaces:**
- Produces: `startConsumer(connection: Redis, queueName: string, onMessage:
  (data: unknown) => Promise<void>, opts?: { concurrency?: number }):
  Worker` (from `bullmq`) — replaces the old
  `Promise<() => Promise<void>>`-returning KafkaJS wrapper. `handleErrorMessage`'s
  signature changes from `(db, redis, producer, rawValue: Buffer)` to
  `(db, redis, producer, data: unknown)` since BullMQ delivers already-
  parsed job data, not a Buffer needing `JSON.parse`.

- [ ] **Step 1: Package swap**

Remove `"kafkajs"`, add `"bullmq": "^5.28.0"` to
`apps/grouping-worker/package.json`.

- [ ] **Step 2: Rewrite the consumer wrapper**

`apps/grouping-worker/src/consumer.ts`:
```ts
import { Worker, type Job } from 'bullmq'
import type { Redis } from 'ioredis'

export type MessageHandler = (data: unknown) => Promise<void>

export function startConsumer(
  connection: Redis,
  queueName: string,
  onMessage: MessageHandler,
  opts: { concurrency?: number } = {}
): Worker {
  const worker = new Worker(
    queueName,
    async (job: Job) => onMessage(job.data),
    { connection, concurrency: opts.concurrency ?? 5 }
  )
  worker.on('failed', (job, err) => {
    console.error(`[${queueName}] job ${job?.id} failed:`, err.message)
  })
  return worker
}
```

- [ ] **Step 3: Rewrite the internal producer (publishes to `work.symbolication`)**

`apps/grouping-worker/src/queue/producer.ts`: identical shape to
`apps/ingest-api/src/queue/producer.ts` (same `QueueProducer` interface and
`createQueueProducer`) — duplicated deliberately, same "each app owns its
own queue client" reasoning already established for the Kafka producers
this replaces.

- [ ] **Step 4: Update `handleErrorMessage`**

Change the signature to accept already-parsed `data: unknown` instead of a
raw `Buffer`, and drop the `JSON.parse(rawValue.toString('utf8'))` line:
```ts
export async function handleErrorMessage(
  db: Kysely<Database>,
  redis: Redis,
  producer: QueueProducer,
  data: unknown
): Promise<void> {
  const parsed = data as IngestErrorMessage
  const event = SentryEventItemSchema.parse(parsed.event)
  // ...unchanged from here...

  if (releaseId && event.exception) {
    await producer.send(
      'work.symbolication',
      'symbolicate',
      { projectId: parsed.projectId, eventId: result.eventId, releaseId, exception: event.exception },
      { attempts: 5, backoff: { type: 'exponential', delay: 1000 } }
    )
  }
}
```

- [ ] **Step 5: Update the test**

`handle-message.test.ts` currently builds a raw `Buffer` message and
constructs a real KafkaJS producer/consumer to assert the
`work.symbolication` publish. Replace: pass a plain object directly to
`handleErrorMessage` instead of `Buffer.from(JSON.stringify(...))`, and
replace the KafkaJS consumer assertion with a dedicated `ioredis`
connection + BullMQ `Queue('work.symbolication').getJob(...)` or a
throwaway `Worker` awaiting one job, same substitution as Task 2.

- [ ] **Step 6: Update `main.ts`**

```ts
import { createDb } from '@flare/db'
import Redis from 'ioredis'
import { startConsumer } from './consumer'
import { handleErrorMessage } from './handle-message'
import { createQueueProducer } from './queue/producer'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379')
const queueConnection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null })
const producer = createQueueProducer(queueConnection)

startConsumer(queueConnection, 'ingest.errors', (data) => handleErrorMessage(db, redis, producer, data))
```

- [ ] **Step 7: Typecheck, build, run test suite, commit**

```bash
git add apps/grouping-worker
git commit -m "feat(grouping-worker): swap Kafka for BullMQ (consumer + internal producer)"
```

---

### Task 4: `transaction-worker` — BullMQ Consumer

**Files:** same shape as Task 3 minus the producer half (this worker never
publishes further) — `src/consumer.ts`, `src/handle-message.ts`, `src/
handle-message.test.ts`, `src/main.ts`, `package.json`. No `src/kafka/`
directory exists here to delete (this app never had its own producer).

**Delta from Task 3:**
- `handleTransactionMessage`'s signature drops the `rawValue: Buffer`
  parameter in favor of `data: unknown`, same substitution.
- `main.ts` consumes `ingest.transactions`, no producer needed.
- Test rewrite follows the same real-Redis-instead-of-real-Kafka
  substitution as Tasks 2/3.

- [ ] Apply the Task 3 pattern to this app; run `pnpm --filter
  @flare/transaction-worker typecheck && pnpm --filter
  @flare/transaction-worker build`; commit:

```bash
git add apps/transaction-worker
git commit -m "feat(transaction-worker): swap Kafka consumer for BullMQ"
```

---

### Task 5: `replay-worker` — BullMQ Consumer

**Files:** same shape as Task 4 — `src/consumer.ts`, `src/
handle-message.ts` (`handleReplayMessage`), `src/main.ts`, `package.json`.
No producer half (this worker never publishes further either).

**Delta:** `handleReplayMessage`'s `rawValue: Buffer` parameter becomes
`data: unknown`; the existing `Buffer.from(message.payload, 'base64')`
line for the `replay_recording` binary payload is unchanged (BullMQ job
data is JSON, so the base64-string-carrying-binary-data trick still
applies exactly as it did for the Kafka message JSON).

- [ ] Apply the Task 3 pattern; run `pnpm --filter @flare/replay-worker
  typecheck && pnpm --filter @flare/replay-worker build`; commit:

```bash
git add apps/replay-worker
git commit -m "feat(replay-worker): swap Kafka consumer for BullMQ"
```

---

### Task 6: `symbolication-worker` — BullMQ Consumer

**Files:** same shape as Task 4/5 — `src/consumer.ts`, `src/
handle-message.ts` (`handleSymbolicationMessage`), `src/main.ts`,
`package.json`. No producer half.

**Delta:** consumes `work.symbolication` instead of `ingest.transactions`/
`ingest.replays`; `rawValue: Buffer` → `data: unknown`, same substitution.

- [ ] Apply the Task 3 pattern; run `pnpm --filter
  @flare/symbolication-worker typecheck && pnpm --filter
  @flare/symbolication-worker build`; commit:

```bash
git add apps/symbolication-worker
git commit -m "feat(symbolication-worker): swap Kafka consumer for BullMQ"
```

---

### Task 7: Remove Kafka from `docker-compose.yml`

**Files:**
- Modify: `docker-compose.yml`

**Interfaces:** none — infra-only change.

- [ ] **Step 1: Delete the `kafka` service entirely.**

- [ ] **Step 2: Enable Redis persistence** (`--appendonly yes`), matching a
  detail worth adopting from the geniusDebug reference project: in-flight
  BullMQ jobs now live only in Redis (there's no Kafka disk log behind
  them anymore), so surviving a container restart without losing queued-
  but-not-yet-processed jobs matters more than it did when Redis was pure
  cache. The `raw_envelope` archive means nothing is unrecoverably lost
  even without this, but AOF persistence avoids needing a backfill run
  after every routine restart.

```yaml
  redis:
    image: redis:7-alpine
    command: ["redis-server", "--appendonly", "yes"]
    volumes:
      - redisdata:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 10

# add to the volumes: block
volumes:
  pgdata:
  redisdata:
```

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yml
git commit -m "chore: remove Kafka, enable Redis AOF persistence for BullMQ durability"
```

---

### Task 8: Raw-Envelope Backfill Script

**Files:**
- Create: `apps/ingest-api/src/scripts/replay-raw-envelopes.ts`
- Modify: `apps/ingest-api/package.json`

**Interfaces:**
- Consumes: `parseEnvelope` (existing), `createQueueProducer` (Task 2),
  `raw_envelope` table (Task 1).
- Produces: a `replay-raw-envelopes` npm script — the concrete
  "reprocess history" capability this whole plan exists to preserve.

- [ ] **Step 1: Add the script entry**

Add to `apps/ingest-api/package.json` scripts:
```json
"replay-raw-envelopes": "tsx src/scripts/replay-raw-envelopes.ts"
```
(add `tsx` as a devDependency if not already present in this app.)

- [ ] **Step 2: Implement it**

`apps/ingest-api/src/scripts/replay-raw-envelopes.ts`:
```ts
import { createDb } from '@flare/db'
import { SentryEventItemSchema, TransactionItemSchema } from '@flare/shared-types'
import Redis from 'ioredis'
import { parseEnvelope } from '../envelope/parse-envelope'
import { createQueueProducer } from '../queue/producer'

interface Args {
  projectId: string
  from: string
  to: string
}

function parseArgs(): Args {
  const args = process.argv.slice(2)
  const get = (flag: string) => {
    const i = args.indexOf(flag)
    if (i === -1 || !args[i + 1]) throw new Error(`missing ${flag}`)
    return args[i + 1]
  }
  return { projectId: get('--project'), from: get('--from'), to: get('--to') }
}

async function main(): Promise<void> {
  const { projectId, from, to } = parseArgs()
  const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')
  const queueConnection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null })
  const producer = createQueueProducer(queueConnection)

  const rows = await db
    .selectFrom('raw_envelope')
    .selectAll()
    .where('project_id', '=', projectId)
    .where('received_at', '>=', new Date(from))
    .where('received_at', '<', new Date(to))
    .execute()

  console.log(`replaying ${rows.length} archived envelopes for project ${projectId}`)

  for (const row of rows) {
    const envelope = parseEnvelope(Buffer.from(row.raw_bytes))
    for (const item of envelope.items) {
      if (item.header.type === 'event') {
        const parsed = SentryEventItemSchema.parse(JSON.parse(item.payload.toString('utf8')))
        await producer.send('ingest.errors', 'error', { projectId, event: parsed }, { jobId: `${projectId}:${parsed.event_id}:replay` })
      } else if (item.header.type === 'transaction') {
        const parsed = TransactionItemSchema.parse(JSON.parse(item.payload.toString('utf8')))
        await producer.send('ingest.transactions', 'transaction', { projectId, event: parsed }, { jobId: `${projectId}:${parsed.event_id}:replay` })
      } else if (item.header.type === 'replay_event' || item.header.type === 'replay_recording') {
        await producer.send('ingest.replays', 'replay', { projectId, itemType: item.header.type, payload: item.payload.toString('base64') })
      }
    }
  }

  await producer.close()
  await db.destroy()
  console.log('done')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
```

Note the `:replay` suffix on replayed jobIds: reusing the exact original
`jobId` would make BullMQ treat a replay as a no-op if the original job
still exists in its completed set, which defeats the purpose of an
intentional reprocess. The DB-level `ON CONFLICT` upserts downstream are
what make a genuine reprocess safe to run repeatedly, not the jobId.

- [ ] **Step 3: Typecheck, build, commit**

```bash
git add apps/ingest-api
git commit -m "feat(ingest-api): raw-envelope backfill/replay script"
```

---

### Task 9: Bull Board — Queue Observability UI

**Files:**
- Modify: `apps/query-api/package.json`
- Create: `apps/query-api/src/queue-board.ts`
- Test: `apps/query-api/src/queue-board.test.ts`
- Modify: `apps/query-api/src/app.ts`
- Modify: `apps/query-api/src/server.ts`

**Interfaces:**
- Produces: `registerQueueBoard(app: FastifyInstance, connection: Redis):
  void`, mounted at `/admin/queues`. `AppDeps` gains `queueConnection: Redis`
  — a **third** Redis role in this system (cache `redis`, BullMQ-producing/
  consuming `queueConnection` in the ingest/worker apps, and here a
  read-only `queueConnection` purely for the board to inspect queue state;
  `query-api` never adds or processes jobs itself).

**Rationale:** this is the concrete answer to the "ops visibility" gap
raised when comparing against Kafka's monitoring ecosystem — Bull Board
gives waiting/active/completed/failed counts and a retry/delete action per
job, for less operational weight than anything Kafka's tooling offered.
It's added now rather than deferred because it's cheap and immediately
useful, not speculative.

**Note:** this mounts on `query-api`, the same service the Web UI's own
pages sit behind. It carries no auth of its own — per this project's
existing assumption (see the original architecture plan's header), the
Web UI/Query API sit behind SOCOTEC's SSO at the ingress level; `/admin/
queues` inherits that same protection and does not need its own login.

- [ ] **Step 1: Add dependencies**

Add to `apps/query-api/package.json` dependencies: `"@bull-board/api":
"^5.21.0"`, `"@bull-board/fastify": "^5.21.0"`, `"bullmq": "^5.28.0"`.

- [ ] **Step 2: Write the failing test**

`apps/query-api/src/queue-board.test.ts`:
```ts
import Redis from 'ioredis'
import { describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import { registerQueueBoard } from './queue-board'

describe('registerQueueBoard', () => {
  it('mounts a route under /admin/queues', async () => {
    const app = Fastify()
    const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
      maxRetriesPerRequest: null,
      lazyConnect: true,
    })
    await registerQueueBoard(app, connection)

    const response = await app.inject({ method: 'GET', url: '/admin/queues' })
    expect(response.statusCode).not.toBe(404)
  })
})
```
(`lazyConnect: true` keeps this test from blocking on an actual TCP
connect attempt in this Docker-less sandbox — the route-registration
assertion doesn't require Redis to be reachable, only the queue-state
rendering does, which this test doesn't exercise.)

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @flare/query-api test -- queue-board`
Expected: FAIL — `Cannot find module './queue-board'`

- [ ] **Step 4: Implement it**

`apps/query-api/src/queue-board.ts`:
```ts
import { createBullBoard } from '@bull-board/api'
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter'
import { FastifyAdapter } from '@bull-board/fastify'
import { Queue } from 'bullmq'
import type { FastifyInstance } from 'fastify'
import type { Redis } from 'ioredis'

const QUEUE_NAMES = ['ingest.errors', 'ingest.transactions', 'ingest.replays', 'work.symbolication']

export async function registerQueueBoard(app: FastifyInstance, connection: Redis): Promise<void> {
  const serverAdapter = new FastifyAdapter()
  serverAdapter.setBasePath('/admin/queues')

  createBullBoard({
    queues: QUEUE_NAMES.map((name) => new BullMQAdapter(new Queue(name, { connection }))),
    serverAdapter,
  })

  await app.register(serverAdapter.registerPlugin(), { prefix: '/admin/queues' })
}
```
(the exact registration call — `serverAdapter.registerPlugin()` and its
options — is verified against the installed package via `tsc`, not
assumed: if the real API surface differs, typecheck fails immediately and
the call is corrected against the actual type definitions rather than
guessed twice.)

- [ ] **Step 5: Wire into `app.ts` and `server.ts`**

`app.ts`: add `queueConnection: Redis` to `AppDeps`; call `await
registerQueueBoard(app, deps.queueConnection)` alongside the other
`register*` calls (note `buildApp` becomes `async` if it wasn't already,
since this registration is awaited).

`server.ts`: construct the third connection and pass it through:
```ts
const queueConnection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null })
```

Update every existing test's `buildApp({...})` call to add
`queueConnection: {} as never` (mirroring how `storage` was stubbed when
it was added in Phase 4), except `queue-board.test.ts` itself which
exercises the real thing directly rather than through `buildApp`.

- [ ] **Step 6: Run test to verify it passes; typecheck; build; run full suite; commit**

Run: `pnpm --filter @flare/query-api test -- queue-board` → PASS (this one
needs no live Redis, per the `lazyConnect` note above).

Run: `pnpm --filter @flare/query-api typecheck && pnpm --filter
@flare/query-api build && pnpm --filter @flare/query-api test` (the rest
of the suite keeps failing on `ECONNREFUSED` as established).

```bash
git add apps/query-api
git commit -m "feat(query-api): mount Bull Board at /admin/queues for queue observability"
```

---

## Verification (after all 9 tasks)

1. `pnpm turbo run lint typecheck build --force` from a clean state — the
   one thing fully verifiable in this Docker-less sandbox, same as every
   prior phase.
2. `grep -r kafkajs apps/*/package.json` returns nothing.
3. On a Docker-enabled machine: `docker compose up -d` (no Kafka container
   should start), run migrations, `pnpm turbo run test` — every
   Redis/Postgres-backed test in this plan should go green, including the
   BullMQ producer/consumer round-trip tests and a live look at
   `/admin/queues` on `query-api`.
4. Manually: send an error event through the envelope endpoint, confirm a
   row lands in `raw_envelope` *and* the issue appears via `grouping-worker`
   as before. Then run `pnpm --filter @flare/ingest-api replay-raw-envelopes
   -- --project <id> --from 2026-01-01 --to 2026-12-31` against a project
   with existing archived envelopes and confirm no duplicate issues/events
   are created (idempotent upserts holding).

## What this plan deliberately does not change

- The four-worker-process shape (`grouping-worker`/`transaction-worker`/
  `replay-worker`/`symbolication-worker` stay separate). Collapsing them
  into fewer processes (the other idea raised alongside the Kafka
  question) is an independent decision, not bundled into this plan.
- No dedicated dead-letter queue (see Global Constraints).
- No search framework (Typesense or otherwise) — out of scope, per the
  original architecture plan and the earlier discussion in this session.

## Documented escape hatches (not built now — no concrete need yet)

- **KEDA autoscaling signal**: point KEDA's `redis` scaler (list-length
  mode) at each queue's underlying Redis key, or expose
  `queue.getWaitingCount()` via a small `/metrics` endpoint per worker for
  KEDA's Prometheus scaler — either replaces the Kafka-consumer-lag signal
  the original deployment plan assumed. Not built here; no autoscaling
  infrastructure exists yet for this to plug into.
- **Fan-out to a second independent consumer of the same event stream**:
  nothing built today needs more than one consumer per queue. If that ever
  changes, the cheapest fix is publishing to a second queue name from the
  existing producer wrapper; Redis Streams is the fallback only if genuine
  log-style replay-per-consumer-group is needed.
