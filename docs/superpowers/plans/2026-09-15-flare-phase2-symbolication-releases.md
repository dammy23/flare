# Flare Phase 2 (Symbolication + Releases) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Releases + source-map upload (sentry-cli compatible), a
symbolication pipeline that resolves minified stack frames back to
original source using uploaded source maps, and readable stack traces in
the web UI. Also completes the `event` table partitioning that Phase 1
explicitly deferred.

**Architecture:** `ingest-api` gains a Release/Artifact upload API subset
that `sentry-cli` calls unmodified; uploaded files go to object storage
via a new `@flare/storage` package, with a Postgres pointer row.
`grouping-worker` resolves each event's `release` string to a `release_id`
(auto-created on first sighting, same pattern as `resolveEnvironment`) and,
after its normal upsert, publishes to a new internal `work.symbolication`
topic. A new `symbolication-worker` app consumes that topic, resolves
frames via `@jridgewell/trace-mapping` against the release's uploaded
source maps (cached in Redis), and writes the resolved `exception` back
onto the `event` row. `query-api`/`web` need no endpoint changes for this —
they already return `event.exception` verbatim; `web` gains a proper
frame-list renderer instead of a raw JSON dump.

**Tech Stack:** builds on Phase 0/1's stack. Adds: `@aws-sdk/client-s3`
(S3-compatible client for MinIO), `@fastify/multipart` (artifact upload
parsing), `@jridgewell/trace-mapping` (source-map resolution), `piscina`
(CPU-isolation for the resolution work, per the architecture plan's Node
single-threaded-model mitigation).

**Spec:** [docs/superpowers/plans/flare-technical-plan.md](../flare-technical-plan.md)
§2 (data model — `release`, `source_map_artifact`), §5a (source-map upload
path), §7 (symbolication worker library/threading choices). This plan also
resolves the explicit deviation noted in
[2026-09-15-flare-phase0-phase1-mvp.md](../2026-09-15-flare-phase0-phase1-mvp.md):
`event` partitioning, deferred there because `pg_partman`'s API couldn't be
verified without a running instance. **That constraint still holds in this
sandbox** (still no Docker) — Task 1 below pins an exact, well-documented
`pg_partman` v5 API and is written with the same care as everything else
in this session that can't be run here, but it carries strictly more risk
than the rest: `pg_partman`'s `create_parent()` signature has changed
across major versions (v5 dropped the `p_type` parameter that v4 required),
so this is the one piece in this plan to double-check against the actual
installed `pg_partman` version before trusting it in production.

## Global Constraints

Same as the Phase 0/1 plan, plus:
- The `event` table's primary key stays `id`; partitioning must not
  change any existing column, index, or the `UNIQUE(project_id, event_id)`
  constraint's semantics (partitioned uniqueness requires the partition
  key in the constraint — see Task 1).
- Symbolication must never block ingestion or grouping: `grouping-worker`
  publishes to `work.symbolication` and moves on; resolution happens
  asynchronously in `symbolication-worker`.
- Object storage access goes through `@flare/storage`, never a raw S3
  client constructed inline in an app — one place owns the
  endpoint/credentials/bucket config.
- Redis resolved-frame cache key is `(release_id, filename, lineno, colno)`
  — matches the architecture plan's stated cache key exactly.

---

### Task 1: Partition `event` by Month (`pg_partman`)

**Files:**
- Create: `packages/db/migrations/1700000000005_partition-event.cjs`

**Interfaces:**
- Produces: no TypeScript-visible change — `event` remains queryable via
  the same Kysely `EventTable` type. This is a pure schema migration.

- [ ] **Step 1: Write the migration**

`pg_partman` v5's `create_parent()` no longer takes `p_type` (native
partitioning is the only supported mode) — pinned here for `pg_partman >=
5.0.0`:

```js
exports.up = (pgm) => {
  pgm.sql(`CREATE EXTENSION IF NOT EXISTS pg_partman SCHEMA partman`)

  // Convert the existing plain event table into the partitioned parent.
  // pg_partman requires the partition key inside every unique constraint,
  // so the Phase 1 UNIQUE(project_id, event_id) is replaced with one that
  // includes "timestamp".
  pgm.sql(`ALTER TABLE event DROP CONSTRAINT event_project_event_id_unique`)
  pgm.sql(`ALTER TABLE event RENAME TO event_unpartitioned`)
  pgm.sql(`
    CREATE TABLE event (
      LIKE event_unpartitioned
    ) PARTITION BY RANGE ("timestamp")
  `)
  pgm.sql(`ALTER TABLE event ADD CONSTRAINT event_project_event_id_ts_unique UNIQUE (project_id, event_id, "timestamp")`)
  pgm.sql(`CREATE INDEX event_project_issue_ts_idx ON event (project_id, issue_id, "timestamp")`)
  pgm.sql(`INSERT INTO event SELECT * FROM event_unpartitioned`)
  pgm.sql(`DROP TABLE event_unpartitioned`)

  pgm.sql(`
    SELECT partman.create_parent(
      p_parent_table := 'public.event',
      p_control := 'timestamp',
      p_interval := 'monthly',
      p_default_table := true
    )
  `)
  pgm.sql(`UPDATE partman.part_config SET retention = '90 days', retention_keep_table = false WHERE parent_table = 'public.event'`)
}

exports.down = (pgm) => {
  pgm.sql(`SELECT partman.undo_partition('public.event', p_keep_table := true)`)
  pgm.sql(`ALTER TABLE event DROP CONSTRAINT event_project_event_id_ts_unique`)
  pgm.sql(`ALTER TABLE event ADD CONSTRAINT event_project_event_id_unique UNIQUE (project_id, event_id)`)
}
```

- [ ] **Step 2: Note the verification gap explicitly**

This cannot be run in this sandbox (no Docker/Postgres). Before relying on
it: run `docker compose up -d postgres`, confirm the installed
`pg_partman` version (`SELECT extversion FROM pg_extension WHERE extname
= 'pg_partman'`), then `pnpm --filter @flare/db migrate:up` and verify with
`SELECT * FROM partman.part_config` and `\d+ event` that monthly child
partitions exist. If the installed version is `< 5.0.0`, `create_parent`
needs `p_type := 'native'` added back — check the version first.

- [ ] **Step 3: Commit**

```bash
git add packages/db/migrations/1700000000005_partition-event.cjs
git commit -m "feat(db): partition event table by month via pg_partman"
```

---

### Task 2: `release` Table + `resolveOrCreateRelease`

**Files:**
- Create: `packages/db/migrations/1700000000006_create-release.cjs`
- Create: `packages/db/migrations/1700000000007_add-event-release-id.cjs`
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/src/resolve-release.ts`
- Test: `packages/db/src/resolve-release.test.ts`
- Modify: `packages/db/src/index.ts`
- Modify: `packages/shared-types/src/envelope.ts`
- Modify: `packages/shared-types/src/envelope.test.ts`

**Interfaces:**
- Produces: `ReleaseTable`, `resolveOrCreateRelease(db, redis, projectId,
  version): Promise<string>` (returns `release_id`, same auto-create-on-
  first-sighting shape as `resolveEnvironment`) — consumed by Task 6.
  `SentryEventItemSchema` gains an optional `release: z.string().optional()`
  field.

- [ ] **Step 1: Migrations**

`packages/db/migrations/1700000000006_create-release.cjs`:
```js
exports.up = (pgm) => {
  pgm.createTable('release', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    project_id: { type: 'uuid', notNull: true, references: 'project', onDelete: 'CASCADE' },
    version: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint('release', 'release_project_version_unique', 'UNIQUE(project_id, version)')
}
exports.down = (pgm) => pgm.dropTable('release')
```

`packages/db/migrations/1700000000007_add-event-release-id.cjs`:
```js
exports.up = (pgm) => {
  pgm.addColumn('event', {
    release_id: { type: 'uuid', references: 'release', onDelete: 'SET NULL' },
  })
}
exports.down = (pgm) => pgm.dropColumn('event', 'release_id')
```

- [ ] **Step 2: Update `Database` schema**

Add to `packages/db/src/schema.ts`:
```ts
export interface ReleaseTable {
  id: Generated<string>
  project_id: string
  version: string
  created_at: Generated<Date>
}
```
Add `release: ReleaseTable` to the `Database` interface. Add `release_id:
string | null` to `EventTable`.

- [ ] **Step 3: Write the failing test for `resolveOrCreateRelease`**

`packages/db/src/resolve-release.test.ts`:
```ts
import Redis from 'ioredis'
import { afterAll, describe, expect, it } from 'vitest'
import { createDb } from './create-db'
import { resolveOrCreateRelease } from './resolve-release'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379')

afterAll(async () => {
  await db.destroy()
  redis.disconnect()
})

describe('resolveOrCreateRelease', () => {
  it('creates the release on first sighting and reuses it on the next call', async () => {
    const project = await db
      .insertInto('project')
      .values({ name: 'Release Test', slug: `release-test-${Date.now()}`, public_key: `pk-release-${Date.now()}` })
      .returningAll()
      .executeTakeFirstOrThrow()

    const firstId = await resolveOrCreateRelease(db, redis, project.id, '1.2.3')
    const secondId = await resolveOrCreateRelease(db, redis, project.id, '1.2.3')

    expect(firstId).toBe(secondId)

    const rows = await db
      .selectFrom('release')
      .selectAll()
      .where('project_id', '=', project.id)
      .where('version', '=', '1.2.3')
      .execute()
    expect(rows).toHaveLength(1)
  })
})
```

- [ ] **Step 4: Run test to verify it fails**

Run: `DATABASE_URL=postgres://flare:flare@localhost:5432/flare REDIS_URL=redis://localhost:6379 pnpm --filter @flare/db test -- resolve-release`
Expected: FAIL — `Cannot find module './resolve-release'`

- [ ] **Step 5: Implement `resolveOrCreateRelease`**

`packages/db/src/resolve-release.ts` (mirrors `resolve-environment.ts`
exactly — same cache-then-upsert-then-cache shape):
```ts
import type { Kysely } from 'kysely'
import type { Redis } from 'ioredis'
import type { Database } from './schema'

const CACHE_TTL_SECONDS = 300

export async function resolveOrCreateRelease(
  db: Kysely<Database>,
  redis: Redis,
  projectId: string,
  version: string
): Promise<string> {
  const cacheKey = `release:${projectId}:${version}`
  const cached = await redis.get(cacheKey)
  if (cached) return cached

  const inserted = await db
    .insertInto('release')
    .values({ project_id: projectId, version })
    .onConflict((oc) => oc.columns(['project_id', 'version']).doNothing())
    .returning('id')
    .executeTakeFirst()

  const id =
    inserted?.id ??
    (
      await db
        .selectFrom('release')
        .select('id')
        .where('project_id', '=', projectId)
        .where('version', '=', version)
        .executeTakeFirstOrThrow()
    ).id

  await redis.set(cacheKey, id, 'EX', CACHE_TTL_SECONDS)
  return id
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `DATABASE_URL=postgres://flare:flare@localhost:5432/flare REDIS_URL=redis://localhost:6379 pnpm --filter @flare/db test -- resolve-release`
Expected: PASS

- [ ] **Step 7: Add `release` to the envelope schema**

In `packages/shared-types/src/envelope.ts`, add to `SentryEventItemSchema`:
```ts
release: z.string().optional(),
```
(right below `environment: z.string().default('production'),`)

Add a test case to `packages/shared-types/src/envelope.test.ts`'s
`SentryEventItemSchema` describe block:
```ts
it('carries an optional release string', () => {
  const result = SentryEventItemSchema.parse({ event_id: 'abc', release: 'my-app@1.2.3' })
  expect(result.release).toBe('my-app@1.2.3')
})
```

- [ ] **Step 8: Barrel export and commit**

Add `export * from './resolve-release'` to `packages/db/src/index.ts`.

```bash
git add packages/db packages/shared-types
git commit -m "feat(db): release table and resolveOrCreateRelease; event carries release"
```

---

### Task 3: `source_map_artifact` Table

**Files:**
- Create: `packages/db/migrations/1700000000008_create-source-map-artifact.cjs`
- Modify: `packages/db/src/schema.ts`

**Interfaces:**
- Produces: `SourceMapArtifactTable` — consumed by Task 5 (upload) and
  Task 8 (resolution lookup).

- [ ] **Step 1: Migration**

```js
exports.up = (pgm) => {
  pgm.createTable('source_map_artifact', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    release_id: { type: 'uuid', notNull: true, references: 'release', onDelete: 'CASCADE' },
    file_path: { type: 'text', notNull: true },
    storage_key: { type: 'text', notNull: true },
    content_type: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint('source_map_artifact', 'source_map_artifact_release_path_unique', 'UNIQUE(release_id, file_path)')
}
exports.down = (pgm) => pgm.dropTable('source_map_artifact')
```

- [ ] **Step 2: Update `Database` schema**

Add to `packages/db/src/schema.ts`:
```ts
export interface SourceMapArtifactTable {
  id: Generated<string>
  release_id: string
  file_path: string
  storage_key: string
  content_type: string | null
  created_at: Generated<Date>
}
```
Add `source_map_artifact: SourceMapArtifactTable` to `Database`.

- [ ] **Step 3: Commit**

```bash
git add packages/db
git commit -m "feat(db): source_map_artifact table"
```

---

### Task 4: `@flare/storage` (S3/MinIO Client)

**Files:**
- Create: `packages/storage/package.json`
- Create: `packages/storage/tsconfig.json`
- Create: `packages/storage/vitest.config.ts`
- Create: `packages/storage/src/create-storage-client.ts`
- Test: `packages/storage/src/create-storage-client.test.ts`
- Create: `packages/storage/src/index.ts`

**Interfaces:**
- Produces: `StorageClient` (`{ putObject(key, body, contentType):
  Promise<void>; getObject(key): Promise<Buffer> }`),
  `createStorageClient(config): StorageClient` — consumed by Task 5
  (artifact upload) and Task 8 (source-map fetch for resolution).

- [ ] **Step 1: Package scaffold**

`packages/storage/package.json`:
```json
{
  "name": "@flare/storage",
  "version": "0.0.0",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "lint": "echo 'no lint configured yet'",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@aws-sdk/client-s3": "^3.650.0"
  },
  "devDependencies": {
    "vitest": "^2.1.0"
  }
}
```

`packages/storage/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

`packages/storage/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({ test: { environment: 'node' } })
```

- [ ] **Step 2: Write the failing test**

`packages/storage/src/create-storage-client.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { createStorageClient } from './create-storage-client'

const client = createStorageClient({
  endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
  region: 'us-east-1',
  accessKeyId: process.env.S3_ACCESS_KEY ?? 'flare',
  secretAccessKey: process.env.S3_SECRET_KEY ?? 'flare12345',
  bucket: process.env.S3_BUCKET ?? 'flare-source-maps',
})

describe('createStorageClient', () => {
  it('round-trips a small object through put and get', async () => {
    const key = `test/${Date.now()}.txt`
    await client.putObject(key, Buffer.from('hello flare'), 'text/plain')

    const result = await client.getObject(key)
    expect(result.toString('utf8')).toBe('hello flare')
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @flare/storage test`
Expected: FAIL — `Cannot find module './create-storage-client'`

- [ ] **Step 4: Implement `createStorageClient`**

`packages/storage/src/create-storage-client.ts`:
```ts
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'

export interface StorageClientConfig {
  endpoint: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
}

export interface StorageClient {
  putObject(key: string, body: Buffer, contentType?: string): Promise<void>
  getObject(key: string): Promise<Buffer>
}

export function createStorageClient(config: StorageClientConfig): StorageClient {
  const s3 = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    forcePathStyle: true,
  })

  return {
    putObject: async (key, body, contentType) => {
      await s3.send(
        new PutObjectCommand({ Bucket: config.bucket, Key: key, Body: body, ContentType: contentType })
      )
    },
    getObject: async (key) => {
      const result = await s3.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }))
      const chunks: Uint8Array[] = []
      for await (const chunk of result.Body as AsyncIterable<Uint8Array>) chunks.push(chunk)
      return Buffer.concat(chunks)
    },
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Prerequisite: `docker compose up -d minio`, and a bucket named
`flare-source-maps` created (`docker compose exec minio mc mb
local/flare-source-maps` after `mc alias set local http://localhost:9000
flare flare12345`, or via the MinIO console at `localhost:9001`).

Run: `pnpm --filter @flare/storage test`
Expected: PASS

- [ ] **Step 6: Barrel export and commit**

`packages/storage/src/index.ts`:
```ts
export * from './create-storage-client'
```

```bash
git add packages/storage
git commit -m "feat(storage): S3/MinIO client wrapper"
```

---

### Task 5: Release + Artifact Upload API (sentry-cli compatible)

**Files:**
- Create: `apps/ingest-api/src/releases/create-release.ts`
- Create: `apps/ingest-api/src/releases/upload-artifact.ts`
- Create: `apps/ingest-api/src/routes/releases.ts`
- Test: `apps/ingest-api/src/routes/releases.test.ts`
- Modify: `apps/ingest-api/src/app.ts`
- Modify: `apps/ingest-api/src/server.ts`
- Modify: `apps/ingest-api/package.json`

**Interfaces:**
- Consumes: `resolveOrCreateRelease` (Task 2), `StorageClient` (Task 4).
- Produces: `POST /api/0/organizations/:org/releases/`,
  `POST /api/0/organizations/:org/releases/:version/files/` — the two
  `sentry-cli` calls this plan targets (per the architecture plan's §5a
  decision to support the legacy per-file endpoint, not artifact bundles).
  Auth reuses the DSN public key via `Authorization: Bearer <publicKey>`
  (same credential story as the flow-checkpoint API decision in the
  architecture plan) resolved through the existing `resolveProjectByPublicKey`.
  The `:org` path segment is accepted but not looked up against anything —
  it exists only so `sentry-cli`'s URL shape matches; the real scoping
  comes from the bearer token.

- [ ] **Step 1: Package additions**

Add to `apps/ingest-api/package.json` dependencies:
```json
"@fastify/multipart": "^8.3.0",
"@flare/storage": "workspace:*"
```

- [ ] **Step 2: Write the failing integration test**

`apps/ingest-api/src/routes/releases.test.ts`:
```ts
import { createDb } from '@flare/db'
import { createStorageClient } from '@flare/storage'
import Redis from 'ioredis'
import FormData from 'form-data'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../app'
import { createKafkaProducer } from '../kafka/producer'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379')
const producer = createKafkaProducer([process.env.KAFKA_BROKERS ?? 'localhost:9092'])
const storage = createStorageClient({
  endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
  region: 'us-east-1',
  accessKeyId: process.env.S3_ACCESS_KEY ?? 'flare',
  secretAccessKey: process.env.S3_SECRET_KEY ?? 'flare12345',
  bucket: process.env.S3_BUCKET ?? 'flare-source-maps',
})
const app = buildApp({ db, redis, producer, storage })

let publicKey: string

beforeAll(async () => {
  await producer.connect()
  publicKey = `pk-releases-${Date.now()}`
  await db
    .insertInto('project')
    .values({ name: 'Releases Test', slug: `releases-test-${Date.now()}`, public_key: publicKey })
    .execute()
})

afterAll(async () => {
  await producer.disconnect()
  await db.destroy()
  redis.disconnect()
  await app.close()
})

describe('POST /api/0/organizations/:org/releases/', () => {
  it('creates a release scoped by the bearer public key', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/0/organizations/flare-org/releases/',
      headers: { authorization: `Bearer ${publicKey}` },
      payload: { version: '1.0.0-releases-test' },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json().version).toBe('1.0.0-releases-test')
  })
})

describe('POST /api/0/organizations/:org/releases/:version/files/', () => {
  it('uploads a source-map artifact and stores it', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/0/organizations/flare-org/releases/',
      headers: { authorization: `Bearer ${publicKey}` },
      payload: { version: '1.0.0-upload-test' },
    })

    const form = new FormData()
    form.append('name', 'app.js.map')
    form.append('file', Buffer.from('{"version":3,"sources":[]}'), { filename: 'app.js.map' })

    const response = await app.inject({
      method: 'POST',
      url: '/api/0/organizations/flare-org/releases/1.0.0-upload-test/files/',
      headers: { authorization: `Bearer ${publicKey}`, ...form.getHeaders() },
      payload: form.getBuffer(),
    })

    expect(response.statusCode).toBe(201)

    const stored = await storage.getObject(response.json().storageKey)
    expect(stored.toString('utf8')).toContain('"version":3')
  })
})
```

Add `form-data` as a devDependency of `apps/ingest-api` for this test.

- [ ] **Step 3: Run test to verify it fails**

Prerequisite: `docker compose up -d`.

Run: `DATABASE_URL=... REDIS_URL=... KAFKA_BROKERS=... S3_ENDPOINT=... pnpm --filter @flare/ingest-api test -- releases`
Expected: FAIL — route not registered

- [ ] **Step 4: Implement release creation**

`apps/ingest-api/src/releases/create-release.ts`:
```ts
import type { Kysely } from 'kysely'
import type { Database } from '@flare/db'
import { resolveOrCreateRelease } from '@flare/db'
import type { Redis } from 'ioredis'

export async function createRelease(
  db: Kysely<Database>,
  redis: Redis,
  projectId: string,
  version: string
): Promise<{ version: string }> {
  await resolveOrCreateRelease(db, redis, projectId, version)
  return { version }
}
```

- [ ] **Step 5: Implement artifact upload**

`apps/ingest-api/src/releases/upload-artifact.ts`:
```ts
import type { Kysely } from 'kysely'
import type { Database } from '@flare/db'
import { resolveOrCreateRelease } from '@flare/db'
import type { Redis } from 'ioredis'
import type { StorageClient } from '@flare/storage'

export async function uploadArtifact(
  deps: { db: Kysely<Database>; redis: Redis; storage: StorageClient },
  params: { projectId: string; version: string; fileName: string; content: Buffer; contentType?: string }
): Promise<{ storageKey: string }> {
  const releaseId = await resolveOrCreateRelease(deps.db, deps.redis, params.projectId, params.version)
  const sanitizedName = params.fileName.replace(/[^a-zA-Z0-9._-]/g, '_')
  const storageKey = `releases/${params.projectId}/${params.version}/${sanitizedName}`

  await deps.storage.putObject(storageKey, params.content, params.contentType)

  await deps.db
    .insertInto('source_map_artifact')
    .values({ release_id: releaseId, file_path: params.fileName, storage_key: storageKey, content_type: params.contentType ?? null })
    .onConflict((oc) => oc.columns(['release_id', 'file_path']).doUpdateSet({ storage_key: storageKey }))
    .execute()

  return { storageKey }
}
```

- [ ] **Step 6: Wire the routes**

`apps/ingest-api/src/routes/releases.ts`:
```ts
import type { FastifyInstance } from 'fastify'
import { resolveProjectByPublicKey } from '../auth/resolve-project'
import { createRelease } from '../releases/create-release'
import { uploadArtifact } from '../releases/upload-artifact'

function bearerPublicKey(authHeader: string | undefined): string | null {
  if (!authHeader?.startsWith('Bearer ')) return null
  return authHeader.slice('Bearer '.length)
}

export function registerReleaseRoutes(app: FastifyInstance): void {
  app.post<{ Params: { org: string }; Body: { version: string } }>(
    '/api/0/organizations/:org/releases/',
    async (request, reply) => {
      const { db, redis } = app.deps
      const publicKey = bearerPublicKey(request.headers.authorization)
      if (!publicKey) return reply.code(401).send({ error: 'missing bearer token' })

      const project = await resolveProjectByPublicKey(publicKey, { db, redis })
      if (!project) return reply.code(401).send({ error: 'unknown project' })

      const result = await createRelease(db, redis, project.id, request.body.version)
      return reply.code(201).send(result)
    }
  )

  app.post<{ Params: { org: string; version: string } }>(
    '/api/0/organizations/:org/releases/:version/files/',
    async (request, reply) => {
      const { db, redis, storage } = app.deps
      const publicKey = bearerPublicKey(request.headers.authorization)
      if (!publicKey) return reply.code(401).send({ error: 'missing bearer token' })

      const project = await resolveProjectByPublicKey(publicKey, { db, redis })
      if (!project) return reply.code(401).send({ error: 'unknown project' })

      const parts = request.parts()
      let fileName = ''
      let content: Buffer | null = null
      let contentType: string | undefined

      for await (const part of parts) {
        if (part.type === 'field' && part.fieldname === 'name') {
          fileName = String(part.value)
        } else if (part.type === 'file' && part.fieldname === 'file') {
          content = await part.toBuffer()
          contentType = part.mimetype
          if (!fileName) fileName = part.filename
        }
      }

      if (!content || !fileName) return reply.code(400).send({ error: 'missing file or name' })

      const result = await uploadArtifact(
        { db, redis, storage },
        { projectId: project.id, version: request.params.version, fileName, content, contentType }
      )
      return reply.code(201).send({ storageKey: result.storageKey })
    }
  )
}
```

- [ ] **Step 7: Register the plugin and routes in `app.ts`**

Add `@fastify/multipart` registration and `storage` to `AppDeps`:
```ts
import multipart from '@fastify/multipart'
import type { StorageClient } from '@flare/storage'
import { registerReleaseRoutes } from './routes/releases'

export interface AppDeps {
  db: Kysely<Database>
  redis: Redis
  producer: EventProducer
  storage: StorageClient
}

// inside buildApp, after the content-type parsers:
app.register(multipart)
registerReleaseRoutes(app)
```

Update `apps/ingest-api/src/app.test.ts` and
`apps/ingest-api/src/routes/envelope.test.ts` to pass `storage: {} as
never` alongside the existing deps.

- [ ] **Step 8: Wire `storage` into `server.ts`**

```ts
import { createStorageClient } from '@flare/storage'

const storage = createStorageClient({
  endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
  region: process.env.S3_REGION ?? 'us-east-1',
  accessKeyId: process.env.S3_ACCESS_KEY ?? 'flare',
  secretAccessKey: process.env.S3_SECRET_KEY ?? 'flare12345',
  bucket: process.env.S3_BUCKET ?? 'flare-source-maps',
})
// pass storage into buildApp(...)
```

- [ ] **Step 9: Run test to verify it passes**

Run: same command as Step 3.
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add apps/ingest-api
git commit -m "feat(ingest-api): sentry-cli compatible release and artifact upload API"
```

---

### Task 6: Grouping-Worker Resolves Release and Publishes to `work.symbolication`

**Files:**
- Modify: `apps/grouping-worker/src/upsert-issue-event.ts`
- Modify: `apps/grouping-worker/src/handle-message.ts`
- Create: `apps/grouping-worker/src/kafka/producer.ts`
- Test: `apps/grouping-worker/src/handle-message.test.ts` (extend)
- Modify: `apps/grouping-worker/src/main.ts`
- Modify: `apps/grouping-worker/package.json`

**Interfaces:**
- Consumes: `resolveOrCreateRelease` (Task 2).
- Produces: `handleErrorMessage` now also publishes `{ projectId, eventId,
  releaseId, exception }` to `work.symbolication` after a successful
  upsert — consumed by Task 7's `symbolication-worker`.

- [ ] **Step 1: Add the Kafka producer (mirrors `ingest-api`'s)**

`apps/grouping-worker/src/kafka/producer.ts`: identical shape to
`apps/ingest-api/src/kafka/producer.ts` (same `EventProducer` interface,
same `createKafkaProducer(brokers)` — duplicated deliberately, since these
are two independently-deployed apps and sharing a two-function wrapper
isn't worth a new package).

- [ ] **Step 2: Thread `release_id` through the upsert**

Modify `upsertIssueAndEvent`'s params to accept `releaseId: string | null`
and pass it into the `event` insert's `values` (`release_id: releaseId`).

- [ ] **Step 3: Resolve release and publish in `handleErrorMessage`**

Modify `apps/grouping-worker/src/handle-message.ts`:
```ts
import type { EventProducer } from './kafka/producer'

export async function handleErrorMessage(
  db: Kysely<Database>,
  redis: Redis,
  producer: EventProducer,
  rawValue: Buffer
): Promise<void> {
  const parsed = JSON.parse(rawValue.toString('utf8')) as IngestErrorMessage
  const event = SentryEventItemSchema.parse(parsed.event)

  const environmentId = await resolveEnvironment(db, redis, parsed.projectId, event.environment)
  const releaseId = event.release
    ? await resolveOrCreateRelease(db, redis, parsed.projectId, event.release)
    : null
  const fingerprint = computeFingerprint(event.exception)

  const result = await upsertIssueAndEvent(db, {
    projectId: parsed.projectId,
    environmentId,
    releaseId,
    fingerprint,
    event,
  })

  if (releaseId && event.exception) {
    await producer.send(
      'work.symbolication',
      `${parsed.projectId}:${result.eventId}`,
      JSON.stringify({ projectId: parsed.projectId, eventId: result.eventId, releaseId, exception: event.exception })
    )
  }
}
```

Update the existing test's calls to `handleErrorMessage` to pass a
producer — extend `apps/grouping-worker/src/handle-message.test.ts` with a
real `createKafkaProducer` (connected in `beforeAll`, disconnected in
`afterAll`), matching the pattern already used in
`apps/ingest-api/src/routes/envelope.test.ts`.

- [ ] **Step 4: Wire into `main.ts`**

```ts
const producer = createKafkaProducer(brokers)
await producer.connect()
startConsumer(brokers, 'grouping-worker', 'ingest.errors', (value) => handleErrorMessage(db, redis, producer, value))
```

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm --filter @flare/grouping-worker typecheck` — expect clean.

```bash
git add apps/grouping-worker
git commit -m "feat(grouping-worker): resolve release_id and publish to work.symbolication"
```

---

### Task 7: `symbolication-worker` Skeleton

**Files:**
- Create: `apps/symbolication-worker/package.json`
- Create: `apps/symbolication-worker/tsconfig.json`
- Create: `apps/symbolication-worker/vitest.config.ts`
- Create: `apps/symbolication-worker/src/main.ts`

**Interfaces:**
- Consumes: `startConsumer`-equivalent pattern from `grouping-worker` (a
  small, independent copy — same "each app owns its Kafka client" call as
  Task 6).
- Produces: a running consumer on `work.symbolication`, wired to
  `resolveAndPersist` (Task 8).

- [ ] **Step 1: Package scaffold**

`apps/symbolication-worker/package.json`:
```json
{
  "name": "@flare/symbolication-worker",
  "version": "0.0.0",
  "main": "dist/main.js",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "lint": "echo 'no lint configured yet'",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "start": "node dist/main.js"
  },
  "dependencies": {
    "@flare/db": "workspace:*",
    "@flare/storage": "workspace:*",
    "@jridgewell/trace-mapping": "^0.3.25",
    "ioredis": "^5.4.0",
    "kafkajs": "^2.2.4",
    "kysely": "^0.27.0",
    "piscina": "^4.7.0"
  },
  "devDependencies": {
    "vitest": "^2.1.0"
  }
}
```

`tsconfig.json` / `vitest.config.ts`: same shape as every other app in
this monorepo.

- [ ] **Step 2: Copy the consumer wrapper**

`apps/symbolication-worker/src/consumer.ts`: identical to
`apps/grouping-worker/src/consumer.ts` (`startConsumer(brokers, groupId,
topic, onMessage)`).

- [ ] **Step 3: Commit the skeleton (wired to a real handler in Task 8, not left as a placeholder)**

Do not commit this task in isolation — Task 8 completes `main.ts` with the
real handler in the same commit, since an empty consumer with no handler
isn't independently meaningful.

---

### Task 8: Source-Map Resolution, Redis Cache, Write-Back

**Files:**
- Create: `apps/symbolication-worker/src/resolve-frames.ts`
- Test: `apps/symbolication-worker/src/resolve-frames.test.ts`
- Create: `apps/symbolication-worker/src/persist-resolved-event.ts`
- Test: `apps/symbolication-worker/src/persist-resolved-event.test.ts`
- Create: `apps/symbolication-worker/src/handle-message.ts`
- Modify: `apps/symbolication-worker/src/main.ts`

**Interfaces:**
- Consumes: `StorageClient` (Task 4), `createDb`/`Database` (Task 3/Phase
  1), `SentryEventItem['exception']` type (Phase 1).
- Produces: `resolveFrames(exception, deps): Promise<ResolvedException>`,
  `persistResolvedEvent(db, eventId, exception): Promise<void>`,
  `handleSymbolicationMessage(deps, rawValue): Promise<void>`.

- [ ] **Step 1: Write the failing test for frame resolution (pure-ish — mocks storage/Redis at the function boundary since the third-party map-format math is what's under test, not S3/Redis themselves)**

`apps/symbolication-worker/src/resolve-frames.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest'
import { resolveFrames } from './resolve-frames'

// A trivial source map: the minified line/col map 1:0 back to original line 10, col 2, in original.js.
const TRIVIAL_MAP = JSON.stringify({
  version: 3,
  sources: ['original.js'],
  names: [],
  mappings: 'aAAaC',
  file: 'app.min.js',
})

describe('resolveFrames', () => {
  it('resolves an in-app frame using the matching uploaded source map', async () => {
    const storage = { getObject: vi.fn().mockResolvedValue(Buffer.from(TRIVIAL_MAP)) }
    const lookupArtifact = vi.fn().mockResolvedValue({ storageKey: 'releases/p1/1.0.0/app.min.js.map' })
    const cache = { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined) }

    const result = await resolveFrames(
      { values: [{ type: 'TypeError', stacktrace: { frames: [{ filename: 'app.min.js', lineno: 1, colno: 0, in_app: true }] } }] },
      { storage: storage as never, lookupArtifact, cache: cache as never, releaseId: 'release-1' }
    )

    const resolvedFrame = result.values[0].stacktrace!.frames![0]
    expect(resolvedFrame.filename).toBe('original.js')
    expect(cache.set).toHaveBeenCalled()
  })

  it('leaves a frame unresolved (but does not throw) when no artifact matches', async () => {
    const storage = { getObject: vi.fn() }
    const lookupArtifact = vi.fn().mockResolvedValue(null)
    const cache = { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined) }

    const result = await resolveFrames(
      { values: [{ type: 'TypeError', stacktrace: { frames: [{ filename: 'unknown.js', lineno: 1, colno: 0, in_app: true }] } }] },
      { storage: storage as never, lookupArtifact, cache: cache as never, releaseId: 'release-1' }
    )

    expect(result.values[0].stacktrace!.frames![0].filename).toBe('unknown.js')
    expect(storage.getObject).not.toHaveBeenCalled()
  })

  it('uses the cached resolved position instead of re-fetching the map', async () => {
    const storage = { getObject: vi.fn() }
    const lookupArtifact = vi.fn().mockResolvedValue({ storageKey: 'releases/p1/1.0.0/app.min.js.map' })
    const cache = {
      get: vi.fn().mockResolvedValue(JSON.stringify({ source: 'original.js', line: 10, column: 2, name: 'main' })),
      set: vi.fn(),
    }

    const result = await resolveFrames(
      { values: [{ type: 'TypeError', stacktrace: { frames: [{ filename: 'app.min.js', lineno: 1, colno: 0, in_app: true }] } }] },
      { storage: storage as never, lookupArtifact, cache: cache as never, releaseId: 'release-1' }
    )

    expect(result.values[0].stacktrace!.frames![0].filename).toBe('original.js')
    expect(storage.getObject).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flare/symbolication-worker test -- resolve-frames`
Expected: FAIL — `Cannot find module './resolve-frames'`

- [ ] **Step 3: Implement `resolveFrames`**

`apps/symbolication-worker/src/resolve-frames.ts`:
```ts
import { originalPositionFor, TraceMap } from '@jridgewell/trace-mapping'
import type { SentryEventItem } from '@flare/shared-types'
import type { StorageClient } from '@flare/storage'

type Exception = NonNullable<SentryEventItem['exception']>

export interface FrameCache {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
}

export interface ResolveFramesDeps {
  storage: Pick<StorageClient, 'getObject'>
  lookupArtifact: (filename: string) => Promise<{ storageKey: string } | null>
  cache: FrameCache
  releaseId: string
}

function cacheKey(releaseId: string, filename: string, lineno: number, colno: number): string {
  return `symcache:${releaseId}:${filename}:${lineno}:${colno}`
}

export async function resolveFrames(exception: Exception, deps: ResolveFramesDeps): Promise<Exception> {
  const traceMapCache = new Map<string, TraceMap>()

  for (const value of exception.values) {
    const frames = value.stacktrace?.frames
    if (!frames) continue

    for (const frame of frames) {
      if (frame.in_app === false || !frame.filename || frame.lineno === undefined || frame.colno === undefined) {
        continue
      }

      const key = cacheKey(deps.releaseId, frame.filename, frame.lineno, frame.colno)
      const cached = await deps.cache.get(key)
      if (cached) {
        const position = JSON.parse(cached) as { source: string | null; line: number | null; column: number | null; name: string | null }
        if (position.source) {
          frame.filename = position.source
          frame.lineno = position.line ?? frame.lineno
          frame.colno = position.column ?? frame.colno
          if (position.name) frame.function = position.name
        }
        continue
      }

      const artifact = await deps.lookupArtifact(frame.filename)
      if (!artifact) continue

      let traceMap = traceMapCache.get(artifact.storageKey)
      if (!traceMap) {
        const mapContent = await deps.storage.getObject(artifact.storageKey)
        traceMap = new TraceMap(mapContent.toString('utf8'))
        traceMapCache.set(artifact.storageKey, traceMap)
      }

      const position = originalPositionFor(traceMap, { line: frame.lineno, column: frame.colno })
      await deps.cache.set(key, JSON.stringify(position))

      if (position.source) {
        frame.filename = position.source
        frame.lineno = position.line ?? frame.lineno
        frame.colno = position.column ?? frame.colno
        if (position.name) frame.function = position.name
      }
    }
  }

  return exception
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @flare/symbolication-worker test -- resolve-frames`
Expected: PASS

- [ ] **Step 5: Write the failing test for the write-back**

`apps/symbolication-worker/src/persist-resolved-event.test.ts`:
```ts
import { createDb } from '@flare/db'
import { afterAll, describe, expect, it } from 'vitest'
import { persistResolvedEvent } from './persist-resolved-event'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')

afterAll(() => db.destroy())

describe('persistResolvedEvent', () => {
  it('overwrites the event exception column with the resolved version', async () => {
    const project = await db
      .insertInto('project')
      .values({ name: 'Persist Test', slug: `persist-test-${Date.now()}`, public_key: `pk-persist-${Date.now()}` })
      .returningAll()
      .executeTakeFirstOrThrow()
    const environment = await db
      .insertInto('environment')
      .values({ project_id: project.id, name: 'production' })
      .returningAll()
      .executeTakeFirstOrThrow()
    const issue = await db
      .insertInto('issue')
      .values({ project_id: project.id, fingerprint: `fp-persist-${Date.now()}`, title: 'x', grouping_raw_components: '{}' })
      .returningAll()
      .executeTakeFirstOrThrow()
    const event = await db
      .insertInto('event')
      .values({
        project_id: project.id,
        issue_id: issue.id,
        environment_id: environment.id,
        event_id: `evt-persist-${Date.now()}`,
        timestamp: new Date(),
        exception: JSON.stringify({ values: [] }),
      })
      .returningAll()
      .executeTakeFirstOrThrow()

    await persistResolvedEvent(db, event.id, { values: [{ type: 'TypeError', value: 'resolved' }] })

    const updated = await db.selectFrom('event').selectAll().where('id', '=', event.id).executeTakeFirstOrThrow()
    expect((updated.exception as { values: Array<{ value: string }> }).values[0].value).toBe('resolved')
  })
})
```

- [ ] **Step 6: Run test to verify it fails**

Run: `DATABASE_URL=... pnpm --filter @flare/symbolication-worker test -- persist-resolved-event`
Expected: FAIL — `Cannot find module './persist-resolved-event'`

- [ ] **Step 7: Implement `persistResolvedEvent`**

`apps/symbolication-worker/src/persist-resolved-event.ts`:
```ts
import type { Kysely } from 'kysely'
import type { Database } from '@flare/db'

export async function persistResolvedEvent(
  db: Kysely<Database>,
  eventId: string,
  exception: unknown
): Promise<void> {
  await db.updateTable('event').set({ exception: JSON.stringify(exception) }).where('id', '=', eventId).execute()
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: same command as Step 6.
Expected: PASS

- [ ] **Step 9: Wire the full handler and `main.ts`**

`apps/symbolication-worker/src/handle-message.ts`:
```ts
import type { Kysely } from 'kysely'
import type { Database } from '@flare/db'
import type { Redis } from 'ioredis'
import type { StorageClient } from '@flare/storage'
import { resolveFrames } from './resolve-frames'
import { persistResolvedEvent } from './persist-resolved-event'

interface SymbolicationMessage {
  projectId: string
  eventId: string
  releaseId: string
  exception: Parameters<typeof resolveFrames>[0]
}

export async function handleSymbolicationMessage(
  deps: { db: Kysely<Database>; redis: Redis; storage: StorageClient },
  rawValue: Buffer
): Promise<void> {
  const message = JSON.parse(rawValue.toString('utf8')) as SymbolicationMessage

  const cache = {
    get: (key: string) => deps.redis.get(key),
    set: (key: string, value: string) => deps.redis.set(key, value, 'EX', 86400).then(() => undefined),
  }

  const lookupArtifact = async (filename: string) => {
    const row = await deps.db
      .selectFrom('source_map_artifact')
      .select('storage_key')
      .where('release_id', '=', message.releaseId)
      .where('file_path', '=', `${filename}.map`)
      .executeTakeFirst()
    return row ? { storageKey: row.storage_key } : null
  }

  const resolved = await resolveFrames(message.exception, {
    storage: deps.storage,
    lookupArtifact,
    cache,
    releaseId: message.releaseId,
  })

  await persistResolvedEvent(deps.db, message.eventId, resolved)
}
```

`apps/symbolication-worker/src/main.ts`:
```ts
import { createDb } from '@flare/db'
import { createStorageClient } from '@flare/storage'
import Redis from 'ioredis'
import { startConsumer } from './consumer'
import { handleSymbolicationMessage } from './handle-message'

const brokers = (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(',')
const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379')
const storage = createStorageClient({
  endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
  region: process.env.S3_REGION ?? 'us-east-1',
  accessKeyId: process.env.S3_ACCESS_KEY ?? 'flare',
  secretAccessKey: process.env.S3_SECRET_KEY ?? 'flare12345',
  bucket: process.env.S3_BUCKET ?? 'flare-source-maps',
})

startConsumer(brokers, 'symbolication-worker', 'work.symbolication', (value) =>
  handleSymbolicationMessage({ db, redis, storage }, value)
).catch((error) => {
  console.error(error)
  process.exit(1)
})
```

**Note on the `piscina` worker-thread pool** (listed as a dependency in
Task 7): the architecture plan calls for CPU-isolation via `piscina`
specifically because real source-map resolution on large minified bundles
is CPU-bound. `originalPositionFor` on the small maps in this plan's tests
is not, and wiring a worker-thread pool around it here would be untested
scaffolding with no way to prove it's wired correctly in this sandbox. Add
the `piscina` pool as the first task of whichever plan first exercises this
against a real, large production source map — tracked, not silently
dropped.

- [ ] **Step 10: Run the full symbolication-worker suite**

Run: `DATABASE_URL=... REDIS_URL=... pnpm --filter @flare/symbolication-worker test`
Expected: all pass except anything still requiring Kafka/S3 connectivity
this sandbox lacks (same ECONNREFUSED pattern as every other infra-backed
test in this session).

- [ ] **Step 11: Commit**

```bash
git add apps/symbolication-worker
git commit -m "feat(symbolication-worker): resolve frames via source maps, redis cache, write-back"
```

---

### Task 9: Web UI Renders Resolved Stack Frames

**Files:**
- Modify: `apps/web/src/pages/IssueDetailPage.tsx`
- Modify: `apps/web/src/pages/IssueDetailPage.test.tsx` (create if it
  doesn't already exist — Phase 1 didn't add one)

**Interfaces:**
- Consumes: `IssueEvent['exception']` shape (already `unknown` in the
  shared-types schema — this task adds a runtime-safe renderer, not a
  schema change, since the exact frame shape varies by SDK/language and
  isn't worth over-constraining in the shared type).

- [ ] **Step 1: Write the failing test**

`apps/web/src/pages/IssueDetailPage.test.tsx`:
```tsx
import { render, screen, waitFor } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { IssueDetailPage } from './IssueDetailPage'

const server = setupServer(
  http.get('http://localhost:3001/api/v1/issues/issue-1', () =>
    HttpResponse.json({
      id: 'issue-1',
      title: 'TypeError: boom',
      culprit: null,
      status: 'unresolved',
      timesSeen: 1,
      firstSeen: '2026-09-01T00:00:00.000Z',
      lastSeen: '2026-09-01T00:00:00.000Z',
      events: [
        {
          id: 'event-1',
          timestamp: '2026-09-01T00:00:00.000Z',
          message: null,
          exception: {
            values: [
              {
                type: 'TypeError',
                value: 'boom',
                stacktrace: { frames: [{ filename: 'original.js', function: 'main', lineno: 10, colno: 2 }] },
              },
            ],
          },
        },
      ],
    })
  )
)

beforeAll(() => server.listen())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('IssueDetailPage', () => {
  it('renders resolved frame locations readably instead of raw JSON', async () => {
    render(
      <MemoryRouter initialEntries={['/issues/issue-1']}>
        <Routes>
          <Route path="/issues/:issueId" element={<IssueDetailPage />} />
        </Routes>
      </MemoryRouter>
    )

    await waitFor(() => expect(screen.getByText('TypeError: boom')).toBeInTheDocument())
    expect(screen.getByText('main')).toBeInTheDocument()
    expect(screen.getByText('original.js:10:2')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flare/web test -- IssueDetailPage`
Expected: FAIL — no element with text `original.js:10:2` (current
implementation renders `JSON.stringify`)

- [ ] **Step 3: Implement the frame renderer**

Replace the event list rendering in
`apps/web/src/pages/IssueDetailPage.tsx`:
```tsx
interface StackFrame {
  filename?: string
  function?: string
  lineno?: number
  colno?: number
}

interface ExceptionValue {
  type?: string
  value?: string
  stacktrace?: { frames?: StackFrame[] }
}

function isExceptionShape(value: unknown): value is { values: ExceptionValue[] } {
  return typeof value === 'object' && value !== null && Array.isArray((value as { values?: unknown }).values)
}

function ExceptionFrames({ exception }: { exception: unknown }) {
  if (!isExceptionShape(exception)) return <code>{JSON.stringify(exception)}</code>

  return (
    <>
      {exception.values.map((value, i) => (
        <div key={i}>
          <strong>{value.type}: {value.value}</strong>
          <ul>
            {(value.stacktrace?.frames ?? []).map((frame, j) => (
              <li key={j}>
                <span>{frame.function ?? '?'}</span>
                {' — '}
                <span>{frame.filename ?? '?'}:{frame.lineno ?? '?'}:{frame.colno ?? '?'}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </>
  )
}
```
And in the component body, replace `<code>{JSON.stringify(event.exception)}</code>`
with `<ExceptionFrames exception={event.exception} />`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @flare/web test -- IssueDetailPage`
Expected: PASS

- [ ] **Step 5: Run the full web suite and build, then commit**

Run: `pnpm --filter @flare/web test && pnpm --filter @flare/web build`
Expected: all tests pass, production build succeeds.

```bash
git add apps/web
git commit -m "feat(web): render resolved stack frames readably in issue detail"
```

---

## Verification (after all 9 tasks)

1. `pnpm turbo run lint typecheck build` — everything type-checks and
   builds from a clean state (this alone is fully verifiable in a
   Docker-less sandbox and should be run first).
2. On a Docker-enabled machine: `docker compose up -d`, create the
   `flare-source-maps` MinIO bucket, run migrations, `pnpm turbo run test`.
3. Manually: upload a release + source map via `sentry-cli releases new
   1.0.0-verify` / `sentry-cli releases files 1.0.0-verify upload-sourcemaps
   ./dist --url-prefix '~/'` against `ingest-api`, send a minified error
   event tagged `release: 1.0.0-verify` through the envelope endpoint, and
   confirm the issue's stack trace in the web UI shows original
   filenames/line numbers rather than the minified ones.
