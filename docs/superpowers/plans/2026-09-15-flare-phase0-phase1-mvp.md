# Flare Phase 0 + Phase 1 (MVP: Error Ingestion + Grouping) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Flare monorepo skeleton and ship the smallest useful
version of Flare: unmodified Sentry SDKs can send error events at a Flare
DSN, events get grouped into issues (with per-environment tracking), and an
internal engineer can see the issue list and stack traces in a web UI.

**Architecture:** `ingest-api` (Fastify) authenticates via DSN public key,
rate-limits, parses the Sentry envelope, and publishes `event`-type items to
Kafka topic `ingest.errors`. `grouping-worker` (KafkaJS consumer) resolves
the environment, computes a fingerprint, and upserts `issue`/`event` rows in
Postgres. `query-api` (Fastify) serves issue data to `web` (React). Redis
backs the public-key→project cache, the environment-name→id cache, and
ingest rate-limit counters. Everything runs via Docker Compose locally.

**Tech Stack:** Node.js 20 + TypeScript (strict), pnpm workspaces +
Turborepo, Fastify, KafkaJS, ioredis, Kysely + node-pg-migrate, zod, Vitest,
React 18 + Vite, Docker Compose, GitHub Actions.

**Spec:** [docs/superpowers/plans/flare-technical-plan.md](../../../docs/superpowers/plans/flare-technical-plan.md)
(copy of the approved architecture plan — see note at the end of this
document about placing it there) — this implementation plan covers §1–§8
and §11 Phase 0/Phase 1 only. Symbolication, dashboards, tracing, replay,
and flow tracing are explicitly out of scope here (later phases, later
plans).

## Global Constraints

- Node.js 20 LTS, TypeScript strict mode everywhere (`"strict": true`).
- Single runtime: Node.js/TypeScript only, no other languages, per the
  fixed architectural decision.
- Redis is cache/coordination only — every Redis-backed lookup in this plan
  has Postgres as its source of truth on a cache miss; nothing is
  Redis-only state.
- All Postgres writes on the ingest path are idempotent upserts
  (`ON CONFLICT`) — Kafka delivery is at-least-once and must be safe to
  replay.
- No bespoke Sentry SDK — `ingest-api` must accept envelopes exactly as an
  unmodified `@sentry/node` or `@sentry/browser` client sends them.
- Package manager is `pnpm` (`pnpm@9`) everywhere; do not use `npm`/`yarn`
  in any command in this plan.
- Every new package gets its own `vitest.config.ts` and runs independently
  via `pnpm --filter <pkg> test`.
- Tests that touch Postgres, Redis, or Kafka run against the real services
  from `docker-compose.yml` (started with `docker compose up -d`) — no
  mocking of these three systems anywhere in this plan. Mocking is
  reserved for the frontend's HTTP boundary (`msw`, in Task 16) and for
  Kafka producer/consumer interfaces where explicitly noted.

---

### Task 1: Monorepo Scaffold

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `turbo.json`
- Create: `tsconfig.base.json`
- Create: `.gitignore`
- Create: `.nvmrc`

**Interfaces:**
- Produces: a pnpm workspace with `packages/*` and `apps/*` globs, a
  `turbo.json` pipeline with `build`, `test`, `lint`, `typecheck` tasks that
  every later package's `package.json` scripts must match by name.

- [ ] **Step 1: Initialize git and the root manifests**

```bash
git init
```

`package.json`:
```json
{
  "name": "flare",
  "private": true,
  "packageManager": "pnpm@9.12.0",
  "scripts": {
    "build": "turbo run build",
    "test": "turbo run test",
    "lint": "turbo run lint",
    "typecheck": "turbo run typecheck"
  },
  "devDependencies": {
    "turbo": "^2.1.0",
    "typescript": "^5.6.0"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - "packages/*"
  - "apps/*"
```

`turbo.json`:
```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "test": { "dependsOn": ["build"] },
    "lint": {},
    "typecheck": { "dependsOn": ["^build"] }
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "composite": true,
    "outDir": "dist",
    "rootDir": "src"
  }
}
```

`.nvmrc`:
```
20
```

`.gitignore`:
```
node_modules/
dist/
.turbo/
.env
*.log
```

- [ ] **Step 2: Install and verify the workspace resolves**

Run: `pnpm install`
Expected: completes with no packages yet (no workspace members exist),
exits 0.

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-workspace.yaml turbo.json tsconfig.base.json .gitignore .nvmrc
git commit -m "chore: scaffold pnpm/turborepo monorepo"
```

---

### Task 2: `shared-types` — Envelope, Item, and Issue DTO Schemas

**Files:**
- Create: `packages/shared-types/package.json`
- Create: `packages/shared-types/tsconfig.json`
- Create: `packages/shared-types/vitest.config.ts`
- Create: `packages/shared-types/src/envelope.ts`
- Create: `packages/shared-types/src/issue.ts`
- Create: `packages/shared-types/src/index.ts`
- Test: `packages/shared-types/src/envelope.test.ts`
- Test: `packages/shared-types/src/issue.test.ts`

**Interfaces:**
- Produces: `EnvelopeHeaderSchema`/`EnvelopeHeader`, `ItemHeaderSchema`/`ItemHeader`,
  `SentryEventItemSchema`/`SentryEventItem` (Task 8/9/14 consume these),
  `IssueSummarySchema`/`IssueSummary`, `IssueDetailSchema`/`IssueDetail`
  (Task 15 and Task 16 consume these).

- [ ] **Step 1: Package scaffold**

`packages/shared-types/package.json`:
```json
{
  "name": "@flare/shared-types",
  "version": "0.0.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "lint": "echo 'no lint configured yet'",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "vitest": "^2.1.0"
  }
}
```

`packages/shared-types/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

`packages/shared-types/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { environment: 'node' },
})
```

- [ ] **Step 2: Write the failing test for envelope schemas**

`packages/shared-types/src/envelope.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { EnvelopeHeaderSchema, ItemHeaderSchema, SentryEventItemSchema } from './envelope'

describe('EnvelopeHeaderSchema', () => {
  it('accepts a header with only event_id', () => {
    const result = EnvelopeHeaderSchema.parse({ event_id: '9ec79c33-1d6e-4c1d-8a7e-000000000000' })
    expect(result.event_id).toBe('9ec79c33-1d6e-4c1d-8a7e-000000000000')
  })
})

describe('ItemHeaderSchema', () => {
  it('accepts a known item type without length', () => {
    const result = ItemHeaderSchema.parse({ type: 'event' })
    expect(result.type).toBe('event')
  })

  it('rejects an unknown item type', () => {
    expect(() => ItemHeaderSchema.parse({ type: 'not_a_real_type' })).toThrow()
  })
})

describe('SentryEventItemSchema', () => {
  it('defaults environment to production when absent', () => {
    const result = SentryEventItemSchema.parse({
      event_id: 'abc123',
      exception: { values: [{ type: 'Error', value: 'boom' }] },
    })
    expect(result.environment).toBe('production')
  })

  it('accepts a full stacktrace with in_app frames', () => {
    const result = SentryEventItemSchema.parse({
      event_id: 'abc123',
      environment: 'staging',
      exception: {
        values: [
          {
            type: 'TypeError',
            value: "Cannot read properties of undefined (reading 'x')",
            stacktrace: {
              frames: [
                { filename: 'app.js', function: 'main', lineno: 10, colno: 3, in_app: true },
              ],
            },
          },
        ],
      },
    })
    expect(result.exception?.values[0]?.stacktrace?.frames?.[0]?.in_app).toBe(true)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @flare/shared-types test`
Expected: FAIL — `Cannot find module './envelope'`

- [ ] **Step 4: Implement the envelope schemas**

`packages/shared-types/src/envelope.ts`:
```ts
import { z } from 'zod'

export const EnvelopeHeaderSchema = z.object({
  event_id: z.string().optional(),
  dsn: z.string().optional(),
  sent_at: z.string().optional(),
})
export type EnvelopeHeader = z.infer<typeof EnvelopeHeaderSchema>

export const ItemHeaderSchema = z.object({
  type: z.enum([
    'event',
    'transaction',
    'replay_event',
    'replay_recording',
    'attachment',
    'session',
    'client_report',
  ]),
  length: z.number().int().nonnegative().optional(),
  content_type: z.string().optional(),
})
export type ItemHeader = z.infer<typeof ItemHeaderSchema>

const StackFrameSchema = z.object({
  filename: z.string().optional(),
  function: z.string().optional(),
  lineno: z.number().optional(),
  colno: z.number().optional(),
  in_app: z.boolean().optional(),
})

const ExceptionValueSchema = z.object({
  type: z.string().optional(),
  value: z.string().optional(),
  stacktrace: z.object({ frames: z.array(StackFrameSchema).optional() }).optional(),
})

export const SentryEventItemSchema = z.object({
  event_id: z.string(),
  timestamp: z.union([z.number(), z.string()]).optional(),
  environment: z.string().default('production'),
  level: z.string().optional(),
  message: z.string().optional(),
  exception: z.object({ values: z.array(ExceptionValueSchema) }).optional(),
})
export type SentryEventItem = z.infer<typeof SentryEventItemSchema>
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @flare/shared-types test`
Expected: PASS (envelope tests)

- [ ] **Step 6: Write the failing test for issue DTO schemas**

`packages/shared-types/src/issue.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { IssueDetailSchema, IssueSummarySchema } from './issue'

describe('IssueSummarySchema', () => {
  it('accepts a minimal issue summary', () => {
    const result = IssueSummarySchema.parse({
      id: 'issue-1',
      title: 'TypeError: boom',
      culprit: 'app.js in main',
      status: 'unresolved',
      timesSeen: 3,
      firstSeen: '2026-09-01T00:00:00.000Z',
      lastSeen: '2026-09-15T00:00:00.000Z',
    })
    expect(result.status).toBe('unresolved')
  })

  it('rejects an invalid status', () => {
    expect(() =>
      IssueSummarySchema.parse({
        id: 'issue-1',
        title: 'x',
        culprit: null,
        status: 'archived',
        timesSeen: 1,
        firstSeen: '2026-09-01T00:00:00.000Z',
        lastSeen: '2026-09-01T00:00:00.000Z',
      })
    ).toThrow()
  })
})

describe('IssueDetailSchema', () => {
  it('extends the summary with a list of recent events', () => {
    const result = IssueDetailSchema.parse({
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
          message: 'boom',
          exception: { values: [] },
        },
      ],
    })
    expect(result.events).toHaveLength(1)
  })
})
```

- [ ] **Step 7: Run test to verify it fails**

Run: `pnpm --filter @flare/shared-types test`
Expected: FAIL — `Cannot find module './issue'`

- [ ] **Step 8: Implement the issue DTO schemas**

`packages/shared-types/src/issue.ts`:
```ts
import { z } from 'zod'

export const IssueStatusSchema = z.enum(['unresolved', 'resolved', 'ignored'])
export type IssueStatus = z.infer<typeof IssueStatusSchema>

export const IssueSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  culprit: z.string().nullable(),
  status: IssueStatusSchema,
  timesSeen: z.number().int().nonnegative(),
  firstSeen: z.string(),
  lastSeen: z.string(),
})
export type IssueSummary = z.infer<typeof IssueSummarySchema>

export const IssueEventSchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  message: z.string().nullable(),
  exception: z.unknown(),
})
export type IssueEvent = z.infer<typeof IssueEventSchema>

export const IssueDetailSchema = IssueSummarySchema.extend({
  events: z.array(IssueEventSchema),
})
export type IssueDetail = z.infer<typeof IssueDetailSchema>
```

- [ ] **Step 9: Run test to verify it passes**

Run: `pnpm --filter @flare/shared-types test`
Expected: PASS (all `shared-types` tests)

- [ ] **Step 10: Barrel export and commit**

`packages/shared-types/src/index.ts`:
```ts
export * from './envelope'
export * from './issue'
```

```bash
git add packages/shared-types
git commit -m "feat(shared-types): envelope and issue DTO schemas"
```

---

### Task 3: `db` — Schema, Migrations, `createDb`

**Files:**
- Create: `packages/db/package.json`
- Create: `packages/db/tsconfig.json`
- Create: `packages/db/vitest.config.ts`
- Create: `packages/db/src/schema.ts`
- Create: `packages/db/src/create-db.ts`
- Create: `packages/db/migrations/1700000000000_create-project.cjs`
- Create: `packages/db/migrations/1700000000001_create-environment.cjs`
- Create: `packages/db/migrations/1700000000002_create-issue.cjs`
- Create: `packages/db/migrations/1700000000003_create-issue-environment.cjs`
- Create: `packages/db/migrations/1700000000004_create-event.cjs`
- Test: `packages/db/src/create-db.test.ts`

**Interfaces:**
- Produces: `Database` (Kysely schema type), `createDb(connectionString: string): Kysely<Database>`
  — consumed by Task 6, 9, 10, 13, 14, 15.

> **Note on partitioning:** the approved architecture plan calls for
> `event` to be `pg_partman`-partitioned from day one. This plan
> deliberately defers that: getting `pg_partman`'s exact function
> signature right without a running instance to verify against risks
> shipping a silently-wrong migration, which is worse than a clearly-scoped
> plain table. `event` is created here as a normal table; converting it to
> a partitioned table is the first task of the Phase 2 implementation plan,
> written against a real `pg_partman` install so its API can be verified.

- [ ] **Step 1: Package scaffold**

`packages/db/package.json`:
```json
{
  "name": "@flare/db",
  "version": "0.0.0",
  "type": "module",
  "main": "dist/create-db.js",
  "types": "dist/create-db.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "lint": "echo 'no lint configured yet'",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "migrate:up": "node-pg-migrate up -m migrations -j cjs",
    "migrate:down": "node-pg-migrate down -m migrations -j cjs"
  },
  "dependencies": {
    "kysely": "^0.27.0",
    "pg": "^8.13.0"
  },
  "devDependencies": {
    "@types/pg": "^8.11.0",
    "node-pg-migrate": "^7.6.0",
    "vitest": "^2.1.0"
  }
}
```

`packages/db/tsconfig.json`: same shape as Task 2's, `include: ["src"]`.

`packages/db/vitest.config.ts`: same as Task 2's.

- [ ] **Step 2: Write the migrations**

`packages/db/migrations/1700000000000_create-project.cjs`:
```js
exports.up = (pgm) => {
  pgm.createExtension('pgcrypto', { ifNotExists: true })
  pgm.createTable('project', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    name: { type: 'text', notNull: true },
    slug: { type: 'text', notNull: true },
    public_key: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint('project', 'project_slug_unique', 'UNIQUE(slug)')
  pgm.addConstraint('project', 'project_public_key_unique', 'UNIQUE(public_key)')
}
exports.down = (pgm) => pgm.dropTable('project')
```

`packages/db/migrations/1700000000001_create-environment.cjs`:
```js
exports.up = (pgm) => {
  pgm.createTable('environment', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    project_id: { type: 'uuid', notNull: true, references: 'project', onDelete: 'CASCADE' },
    name: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint('environment', 'environment_project_name_unique', 'UNIQUE(project_id, name)')
}
exports.down = (pgm) => pgm.dropTable('environment')
```

`packages/db/migrations/1700000000002_create-issue.cjs`:
```js
exports.up = (pgm) => {
  pgm.createTable('issue', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    project_id: { type: 'uuid', notNull: true, references: 'project', onDelete: 'CASCADE' },
    fingerprint: { type: 'text', notNull: true },
    title: { type: 'text', notNull: true },
    culprit: { type: 'text' },
    status: { type: 'text', notNull: true, default: 'unresolved' },
    first_seen: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    last_seen: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    times_seen: { type: 'integer', notNull: true, default: 1 },
    grouping_raw_components: { type: 'jsonb', notNull: true, default: '{}' },
  })
  pgm.addConstraint('issue', 'issue_project_fingerprint_unique', 'UNIQUE(project_id, fingerprint)')
  pgm.addConstraint(
    'issue',
    'issue_status_check',
    "CHECK (status IN ('unresolved', 'resolved', 'ignored'))"
  )
  pgm.createIndex('issue', ['project_id', 'status', 'last_seen'])
}
exports.down = (pgm) => pgm.dropTable('issue')
```

`packages/db/migrations/1700000000003_create-issue-environment.cjs`:
```js
exports.up = (pgm) => {
  pgm.createTable('issue_environment', {
    issue_id: { type: 'uuid', notNull: true, references: 'issue', onDelete: 'CASCADE' },
    environment_id: { type: 'uuid', notNull: true, references: 'environment', onDelete: 'CASCADE' },
    first_seen: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    last_seen: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    times_seen: { type: 'integer', notNull: true, default: 1 },
  })
  pgm.addConstraint('issue_environment', 'issue_environment_pk', 'PRIMARY KEY (issue_id, environment_id)')
}
exports.down = (pgm) => pgm.dropTable('issue_environment')
```

`packages/db/migrations/1700000000004_create-event.cjs`:
```js
exports.up = (pgm) => {
  pgm.createTable('event', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    project_id: { type: 'uuid', notNull: true, references: 'project', onDelete: 'CASCADE' },
    issue_id: { type: 'uuid', notNull: true, references: 'issue', onDelete: 'CASCADE' },
    environment_id: { type: 'uuid', notNull: true, references: 'environment', onDelete: 'CASCADE' },
    event_id: { type: 'text', notNull: true },
    timestamp: { type: 'timestamptz', notNull: true },
    level: { type: 'text' },
    message: { type: 'text' },
    exception: { type: 'jsonb' },
    received_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint('event', 'event_project_event_id_unique', 'UNIQUE(project_id, event_id)')
  pgm.createIndex('event', ['project_id', 'issue_id', 'timestamp'])
}
exports.down = (pgm) => pgm.dropTable('event')
```

- [ ] **Step 3: Write the failing test for `createDb`**

`packages/db/src/create-db.test.ts`:
```ts
import { execSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb } from './create-db'
import type { Database } from './schema'
import type { Kysely } from 'kysely'

const connectionString =
  process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare'

let db: Kysely<Database>

beforeAll(() => {
  execSync('pnpm migrate:up', {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, DATABASE_URL: connectionString },
    stdio: 'inherit',
  })
  db = createDb(connectionString)
})

afterAll(async () => {
  await db.destroy()
})

describe('createDb', () => {
  it('inserts and reads back a project row', async () => {
    const inserted = await db
      .insertInto('project')
      .values({ name: 'Test App', slug: `test-app-${Date.now()}`, public_key: `pk-${Date.now()}` })
      .returningAll()
      .executeTakeFirstOrThrow()

    const found = await db
      .selectFrom('project')
      .selectAll()
      .where('id', '=', inserted.id)
      .executeTakeFirstOrThrow()

    expect(found.name).toBe('Test App')
  })
})
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm --filter @flare/db test`
Expected: FAIL — `Cannot find module './create-db'` (and/or `./schema`)

- [ ] **Step 5: Implement the schema and `createDb`**

`packages/db/src/schema.ts`:
```ts
import type { Generated } from 'kysely'

export interface Database {
  project: ProjectTable
  environment: EnvironmentTable
  issue: IssueTable
  issue_environment: IssueEnvironmentTable
  event: EventTable
}

export interface ProjectTable {
  id: Generated<string>
  name: string
  slug: string
  public_key: string
  created_at: Generated<Date>
}

export interface EnvironmentTable {
  id: Generated<string>
  project_id: string
  name: string
  created_at: Generated<Date>
}

export type IssueStatus = 'unresolved' | 'resolved' | 'ignored'

export interface IssueTable {
  id: Generated<string>
  project_id: string
  fingerprint: string
  title: string
  culprit: string | null
  status: Generated<IssueStatus>
  first_seen: Generated<Date>
  last_seen: Date
  times_seen: Generated<number>
  grouping_raw_components: unknown
}

export interface IssueEnvironmentTable {
  issue_id: string
  environment_id: string
  first_seen: Generated<Date>
  last_seen: Date
  times_seen: Generated<number>
}

export interface EventTable {
  id: Generated<string>
  project_id: string
  issue_id: string
  environment_id: string
  event_id: string
  timestamp: Date
  level: string | null
  message: string | null
  exception: unknown
  received_at: Generated<Date>
}
```

`packages/db/src/create-db.ts`:
```ts
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import type { Database } from './schema'

export function createDb(connectionString: string): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new Pool({ connectionString }) }),
  })
}
```

- [ ] **Step 6: Run test to verify it passes**

Prerequisite: `docker compose up -d postgres` (from Task 4 — if Task 4 has
not run yet, start a throwaway Postgres: `docker run -d --rm -p 5432:5432
-e POSTGRES_USER=flare -e POSTGRES_PASSWORD=flare -e POSTGRES_DB=flare
postgres:16`).

Run: `DATABASE_URL=postgres://flare:flare@localhost:5432/flare pnpm --filter @flare/db test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/db
git commit -m "feat(db): schema, migrations, and createDb factory"
```

---

### Task 4: Docker Compose — Local Dev Stack

**Files:**
- Create: `docker-compose.yml`
- Create: `.env.example`

**Interfaces:**
- Produces: `postgres` (5432), `redis` (6379), `kafka` (9092), `minio`
  (9000/9001) services that every subsequent task's tests and every app's
  `server.ts`/`main.ts` connect to via `DATABASE_URL`, `REDIS_URL`,
  `KAFKA_BROKERS` env vars.

- [ ] **Step 1: Write the compose file**

`docker-compose.yml`:
```yaml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: flare
      POSTGRES_PASSWORD: flare
      POSTGRES_DB: flare
    ports: ["5432:5432"]
    volumes: ["pgdata:/var/lib/postgresql/data"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U flare"]
      interval: 5s
      timeout: 5s
      retries: 10

  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 10

  kafka:
    image: bitnami/kafka:3.7
    environment:
      KAFKA_CFG_NODE_ID: "1"
      KAFKA_CFG_PROCESS_ROLES: "broker,controller"
      KAFKA_CFG_CONTROLLER_QUORUM_VOTERS: "1@kafka:9093"
      KAFKA_CFG_LISTENERS: "PLAINTEXT://:9092,CONTROLLER://:9093"
      KAFKA_CFG_ADVERTISED_LISTENERS: "PLAINTEXT://localhost:9092"
      KAFKA_CFG_LISTENER_SECURITY_PROTOCOL_MAP: "CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT"
      KAFKA_CFG_CONTROLLER_LISTENER_NAMES: "CONTROLLER"
      KAFKA_CFG_AUTO_CREATE_TOPICS_ENABLE: "true"
      ALLOW_PLAINTEXT_LISTENER: "yes"
    ports: ["9092:9092"]

  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: flare
      MINIO_ROOT_PASSWORD: flare12345
    ports: ["9000:9000", "9001:9001"]

volumes:
  pgdata:
```

`.env.example`:
```
DATABASE_URL=postgres://flare:flare@localhost:5432/flare
REDIS_URL=redis://localhost:6379
KAFKA_BROKERS=localhost:9092
```

- [ ] **Step 2: Verify the stack comes up healthy**

Run: `docker compose up -d && docker compose ps`
Expected: all four services show as `running` (postgres/redis report
`healthy` once their healthchecks pass — allow ~15s).

- [ ] **Step 3: Verify Kafka accepts a produced message end-to-end**

Run:
```bash
docker compose exec kafka kafka-topics.sh --bootstrap-server localhost:9092 --create --topic smoke-test --if-not-exists
docker compose exec kafka bash -c "echo hello | kafka-console-producer.sh --bootstrap-server localhost:9092 --topic smoke-test"
docker compose exec kafka kafka-console-consumer.sh --bootstrap-server localhost:9092 --topic smoke-test --from-beginning --max-messages 1
```
Expected: the consumer prints `hello`.

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml .env.example
git commit -m "chore: add docker compose local dev stack"
```

---

### Task 5: `ingest-api` Skeleton (Fastify, health check)

**Files:**
- Create: `apps/ingest-api/package.json`
- Create: `apps/ingest-api/tsconfig.json`
- Create: `apps/ingest-api/vitest.config.ts`
- Create: `apps/ingest-api/src/app.ts`
- Create: `apps/ingest-api/src/server.ts`
- Test: `apps/ingest-api/src/app.test.ts`

**Interfaces:**
- Produces: `buildApp(deps: AppDeps): FastifyInstance`, `AppDeps` interface
  (`db`, `redis`, `producer` — `producer` added in Task 9) — every later
  ingest-api task adds routes onto this same `buildApp`.

- [ ] **Step 1: Package scaffold**

`apps/ingest-api/package.json`:
```json
{
  "name": "@flare/ingest-api",
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "lint": "echo 'no lint configured yet'",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "start": "node dist/server.js"
  },
  "dependencies": {
    "@flare/db": "workspace:*",
    "@flare/shared-types": "workspace:*",
    "fastify": "^4.28.0",
    "ioredis": "^5.4.0"
  },
  "devDependencies": {
    "vitest": "^2.1.0"
  }
}
```

`apps/ingest-api/tsconfig.json` / `vitest.config.ts`: same shape as Task 2's.

- [ ] **Step 2: Write the failing test for the health check**

`apps/ingest-api/src/app.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { buildApp } from './app'

describe('buildApp', () => {
  it('responds 200 on GET /healthz', async () => {
    const app = buildApp({ db: {} as never, redis: {} as never })
    const response = await app.inject({ method: 'GET', url: '/healthz' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: 'ok' })
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @flare/ingest-api test`
Expected: FAIL — `Cannot find module './app'`

- [ ] **Step 4: Implement `buildApp`**

`apps/ingest-api/src/app.ts`:
```ts
import Fastify, { type FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import type { Database } from '@flare/db'
import type { Redis } from 'ioredis'

export interface AppDeps {
  db: Kysely<Database>
  redis: Redis
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: true })
  app.decorate('deps', deps)

  app.get('/healthz', async () => ({ status: 'ok' }))

  return app
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @flare/ingest-api test`
Expected: PASS

- [ ] **Step 6: Entrypoint and commit**

`apps/ingest-api/src/server.ts`:
```ts
import { createDb } from '@flare/db'
import Redis from 'ioredis'
import { buildApp } from './app'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379')

const app = buildApp({ db, redis })

app
  .listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' })
  .catch((error) => {
    app.log.error(error)
    process.exit(1)
  })
```

```bash
git add apps/ingest-api
git commit -m "feat(ingest-api): fastify skeleton with health check"
```

---

### Task 6: DSN Auth — `resolveProjectByPublicKey`

**Files:**
- Create: `apps/ingest-api/src/auth/resolve-project.ts`
- Create: `apps/ingest-api/src/auth/parse-sentry-auth-header.ts`
- Test: `apps/ingest-api/src/auth/resolve-project.test.ts`
- Test: `apps/ingest-api/src/auth/parse-sentry-auth-header.test.ts`

**Interfaces:**
- Consumes: `Database`/`createDb` (Task 3).
- Produces: `Project` type (`id`, `name`, `slug`, `publicKey`),
  `resolveProjectByPublicKey(publicKey, { db, redis }): Promise<Project | null>`,
  `parseSentryAuthHeader(headerValue): string | null` — both consumed by
  Task 9's envelope route.

- [ ] **Step 1: Write the failing test for header parsing (pure, no infra)**

`apps/ingest-api/src/auth/parse-sentry-auth-header.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { parseSentryAuthHeader } from './parse-sentry-auth-header'

describe('parseSentryAuthHeader', () => {
  it('extracts sentry_key from a standard header', () => {
    const header = 'Sentry sentry_version=7, sentry_key=abc123, sentry_client=sentry.javascript.node/8.0.0'
    expect(parseSentryAuthHeader(header)).toBe('abc123')
  })

  it('returns null when the header is missing', () => {
    expect(parseSentryAuthHeader(undefined)).toBeNull()
  })

  it('returns null when sentry_key is absent', () => {
    expect(parseSentryAuthHeader('Sentry sentry_version=7')).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flare/ingest-api test`
Expected: FAIL — `Cannot find module './parse-sentry-auth-header'`

- [ ] **Step 3: Implement header parsing**

`apps/ingest-api/src/auth/parse-sentry-auth-header.ts`:
```ts
export function parseSentryAuthHeader(headerValue: string | undefined): string | null {
  if (!headerValue) return null
  const match = headerValue.match(/sentry_key=([^,\s]+)/)
  return match ? match[1] : null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @flare/ingest-api test`
Expected: PASS

- [ ] **Step 5: Write the failing test for project resolution (real Postgres + Redis)**

`apps/ingest-api/src/auth/resolve-project.test.ts`:
```ts
import { createDb } from '@flare/db'
import Redis from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolveProjectByPublicKey } from './resolve-project'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379')

afterAll(async () => {
  await db.destroy()
  redis.disconnect()
})

describe('resolveProjectByPublicKey', () => {
  it('returns null for an unknown key', async () => {
    const result = await resolveProjectByPublicKey('does-not-exist', { db, redis })
    expect(result).toBeNull()
  })

  it('resolves a project from Postgres and caches it in Redis', async () => {
    const publicKey = `pk-resolve-${Date.now()}`
    const inserted = await db
      .insertInto('project')
      .values({ name: 'Resolve Test', slug: `resolve-test-${Date.now()}`, public_key: publicKey })
      .returningAll()
      .executeTakeFirstOrThrow()

    const first = await resolveProjectByPublicKey(publicKey, { db, redis })
    expect(first?.id).toBe(inserted.id)

    const cached = await redis.get(`dsn:${publicKey}`)
    expect(cached).not.toBeNull()

    const second = await resolveProjectByPublicKey(publicKey, { db, redis })
    expect(second?.id).toBe(inserted.id)
  })
})
```

- [ ] **Step 6: Run test to verify it fails**

Prerequisite: `docker compose up -d postgres redis` (or the throwaway
containers from Task 3 Step 6).

Run: `DATABASE_URL=postgres://flare:flare@localhost:5432/flare REDIS_URL=redis://localhost:6379 pnpm --filter @flare/ingest-api test`
Expected: FAIL — `Cannot find module './resolve-project'`

- [ ] **Step 7: Implement `resolveProjectByPublicKey`**

`apps/ingest-api/src/auth/resolve-project.ts`:
```ts
import type { Kysely } from 'kysely'
import type { Database } from '@flare/db'
import type { Redis } from 'ioredis'

export interface Project {
  id: string
  name: string
  slug: string
  publicKey: string
}

const CACHE_TTL_SECONDS = 300

export async function resolveProjectByPublicKey(
  publicKey: string,
  deps: { db: Kysely<Database>; redis: Redis }
): Promise<Project | null> {
  const cacheKey = `dsn:${publicKey}`
  const cached = await deps.redis.get(cacheKey)
  if (cached) return JSON.parse(cached) as Project

  const row = await deps.db
    .selectFrom('project')
    .select(['id', 'name', 'slug', 'public_key'])
    .where('public_key', '=', publicKey)
    .executeTakeFirst()

  if (!row) return null

  const project: Project = { id: row.id, name: row.name, slug: row.slug, publicKey: row.public_key }
  await deps.redis.set(cacheKey, JSON.stringify(project), 'EX', CACHE_TTL_SECONDS)
  return project
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `DATABASE_URL=postgres://flare:flare@localhost:5432/flare REDIS_URL=redis://localhost:6379 pnpm --filter @flare/ingest-api test`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add apps/ingest-api/src/auth
git commit -m "feat(ingest-api): DSN public-key auth resolution"
```

---

### Task 7: Rate Limiting — `checkRateLimit`

**Files:**
- Create: `apps/ingest-api/src/rate-limit/check-rate-limit.ts`
- Test: `apps/ingest-api/src/rate-limit/check-rate-limit.test.ts`

**Interfaces:**
- Produces: `RateLimitCategory` (`'error' | 'transaction' | 'replay' | 'attachment'`),
  `RateLimitResult` (`{ allowed: boolean; retryAfterSeconds?: number }`),
  `checkRateLimit(redis, projectId, category): Promise<RateLimitResult>` —
  consumed by Task 9's envelope route.

- [ ] **Step 1: Write the failing test**

`apps/ingest-api/src/rate-limit/check-rate-limit.test.ts`:
```ts
import Redis from 'ioredis'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { checkRateLimit } from './check-rate-limit'

const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379')
const projectId = 'rate-limit-test-project'

afterEach(async () => {
  await redis.del(`ratelimit:${projectId}:error`)
})

afterAll(() => redis.disconnect())

describe('checkRateLimit', () => {
  it('allows requests under the limit', async () => {
    const result = await checkRateLimit(redis, projectId, 'error', { limit: 5, windowSeconds: 60 })
    expect(result.allowed).toBe(true)
  })

  it('blocks requests once the limit is exceeded', async () => {
    for (let i = 0; i < 3; i += 1) {
      await checkRateLimit(redis, projectId, 'error', { limit: 3, windowSeconds: 60 })
    }
    const result = await checkRateLimit(redis, projectId, 'error', { limit: 3, windowSeconds: 60 })
    expect(result.allowed).toBe(false)
    expect(result.retryAfterSeconds).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `REDIS_URL=redis://localhost:6379 pnpm --filter @flare/ingest-api test`
Expected: FAIL — `Cannot find module './check-rate-limit'`

- [ ] **Step 3: Implement `checkRateLimit`**

`apps/ingest-api/src/rate-limit/check-rate-limit.ts`:
```ts
import type { Redis } from 'ioredis'

export type RateLimitCategory = 'error' | 'transaction' | 'replay' | 'attachment'

export interface RateLimitResult {
  allowed: boolean
  retryAfterSeconds?: number
}

export interface RateLimitOptions {
  limit: number
  windowSeconds: number
}

export async function checkRateLimit(
  redis: Redis,
  projectId: string,
  category: RateLimitCategory,
  options: RateLimitOptions = { limit: 1000, windowSeconds: 60 }
): Promise<RateLimitResult> {
  const key = `ratelimit:${projectId}:${category}`
  const count = await redis.incr(key)
  if (count === 1) {
    await redis.expire(key, options.windowSeconds)
  }
  if (count <= options.limit) {
    return { allowed: true }
  }
  const ttl = await redis.ttl(key)
  return { allowed: false, retryAfterSeconds: ttl > 0 ? ttl : options.windowSeconds }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `REDIS_URL=redis://localhost:6379 pnpm --filter @flare/ingest-api test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/ingest-api/src/rate-limit
git commit -m "feat(ingest-api): redis token-bucket rate limiting"
```

---

### Task 8: Envelope Parser (byte-accurate, pure)

**Files:**
- Create: `apps/ingest-api/src/envelope/parse-envelope.ts`
- Test: `apps/ingest-api/src/envelope/parse-envelope.test.ts`

**Interfaces:**
- Consumes: `EnvelopeHeaderSchema`, `ItemHeaderSchema` (Task 2).
- Produces: `ParsedEnvelope` (`{ header: EnvelopeHeader; items: ParsedEnvelopeItem[] }`),
  `ParsedEnvelopeItem` (`{ header: ItemHeader; payload: Buffer }`),
  `parseEnvelope(raw: Buffer): ParsedEnvelope` — consumed by Task 9.

- [ ] **Step 1: Write the failing test**

`apps/ingest-api/src/envelope/parse-envelope.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { parseEnvelope } from './parse-envelope'

function envelopeBuffer(lines: (string | Buffer)[]): Buffer {
  return Buffer.concat(
    lines.map((line) => (Buffer.isBuffer(line) ? Buffer.concat([line, Buffer.from('\n')]) : Buffer.from(line + '\n')))
  )
}

describe('parseEnvelope', () => {
  it('parses a single event item with explicit length', () => {
    const payload = JSON.stringify({ event_id: 'abc', exception: { values: [] } })
    const raw = envelopeBuffer([
      JSON.stringify({ event_id: 'abc' }),
      JSON.stringify({ type: 'event', length: Buffer.byteLength(payload) }),
      payload,
    ])

    const result = parseEnvelope(raw)

    expect(result.header.event_id).toBe('abc')
    expect(result.items).toHaveLength(1)
    expect(result.items[0].header.type).toBe('event')
    expect(JSON.parse(result.items[0].payload.toString('utf8'))).toEqual({
      event_id: 'abc',
      exception: { values: [] },
    })
  })

  it('parses an item with no explicit length by reading to the next newline', () => {
    const raw = envelopeBuffer([
      JSON.stringify({ event_id: 'no-length' }),
      JSON.stringify({ type: 'event' }),
      JSON.stringify({ event_id: 'no-length', exception: { values: [] } }),
    ])

    const result = parseEnvelope(raw)
    expect(result.items).toHaveLength(1)
    expect(JSON.parse(result.items[0].payload.toString('utf8')).event_id).toBe('no-length')
  })

  it('parses multiple items, including one with a binary payload containing newlines', () => {
    const binaryPayload = Buffer.from([0x01, 0x0a, 0x02, 0x0a, 0x03])
    const eventPayload = JSON.stringify({ event_id: 'multi', exception: { values: [] } })
    const raw = envelopeBuffer([
      JSON.stringify({ event_id: 'multi' }),
      JSON.stringify({ type: 'event', length: Buffer.byteLength(eventPayload) }),
      eventPayload,
      JSON.stringify({ type: 'attachment', length: binaryPayload.length }),
      binaryPayload,
    ])

    const result = parseEnvelope(raw)
    expect(result.items).toHaveLength(2)
    expect(result.items[1].header.type).toBe('attachment')
    expect(result.items[1].payload.equals(binaryPayload)).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flare/ingest-api test`
Expected: FAIL — `Cannot find module './parse-envelope'`

- [ ] **Step 3: Implement `parseEnvelope`**

`apps/ingest-api/src/envelope/parse-envelope.ts`:
```ts
import { EnvelopeHeaderSchema, ItemHeaderSchema, type EnvelopeHeader, type ItemHeader } from '@flare/shared-types'

export interface ParsedEnvelopeItem {
  header: ItemHeader
  payload: Buffer
}

export interface ParsedEnvelope {
  header: EnvelopeHeader
  items: ParsedEnvelopeItem[]
}

function readLine(buffer: Buffer, offset: number): { line: Buffer; nextOffset: number } {
  const newlineIndex = buffer.indexOf(0x0a, offset)
  if (newlineIndex === -1) {
    return { line: buffer.subarray(offset), nextOffset: buffer.length }
  }
  return { line: buffer.subarray(offset, newlineIndex), nextOffset: newlineIndex + 1 }
}

export function parseEnvelope(raw: Buffer): ParsedEnvelope {
  let offset = 0

  const headerLine = readLine(raw, offset)
  const header = EnvelopeHeaderSchema.parse(JSON.parse(headerLine.line.toString('utf8')))
  offset = headerLine.nextOffset

  const items: ParsedEnvelopeItem[] = []

  while (offset < raw.length) {
    const itemHeaderLine = readLine(raw, offset)
    if (itemHeaderLine.line.length === 0) {
      offset = itemHeaderLine.nextOffset
      continue
    }
    const itemHeader = ItemHeaderSchema.parse(JSON.parse(itemHeaderLine.line.toString('utf8')))
    offset = itemHeaderLine.nextOffset

    let payload: Buffer
    if (typeof itemHeader.length === 'number') {
      payload = raw.subarray(offset, offset + itemHeader.length)
      offset += itemHeader.length
      if (raw[offset] === 0x0a) offset += 1
    } else {
      const payloadLine = readLine(raw, offset)
      payload = Buffer.from(payloadLine.line)
      offset = payloadLine.nextOffset
    }

    items.push({ header: itemHeader, payload })
  }

  return { header, items }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @flare/ingest-api test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/ingest-api/src/envelope
git commit -m "feat(ingest-api): byte-accurate sentry envelope parser"
```

---

### Task 9: Kafka Producer + Envelope Endpoint

**Files:**
- Create: `apps/ingest-api/src/kafka/producer.ts`
- Modify: `apps/ingest-api/src/app.ts`
- Create: `apps/ingest-api/src/routes/envelope.ts`
- Modify: `apps/ingest-api/src/server.ts`
- Test: `apps/ingest-api/src/routes/envelope.test.ts`

**Interfaces:**
- Consumes: `resolveProjectByPublicKey`, `parseSentryAuthHeader` (Task 6),
  `checkRateLimit` (Task 7), `parseEnvelope` (Task 8), `SentryEventItemSchema`
  (Task 2).
- Produces: `EventProducer` interface (`send(topic, key, value): Promise<void>`,
  `connect()`/`disconnect()`), `createKafkaProducer(brokers): EventProducer`
  — `producer` added to `AppDeps`, consumed by Task 14's grouping-worker
  test as the thing that publishes onto `ingest.errors`.

- [ ] **Step 1: Implement the Kafka producer (no test — thin KafkaJS wrapper, exercised by Step 4's integration test)**

`apps/ingest-api/src/kafka/producer.ts`:
```ts
import { Kafka } from 'kafkajs'

export interface EventProducer {
  connect(): Promise<void>
  disconnect(): Promise<void>
  send(topic: string, key: string, value: Buffer | string): Promise<void>
}

export function createKafkaProducer(brokers: string[]): EventProducer {
  const kafka = new Kafka({ clientId: 'ingest-api', brokers })
  const producer = kafka.producer()

  return {
    connect: () => producer.connect(),
    disconnect: () => producer.disconnect(),
    send: async (topic, key, value) => {
      await producer.send({ topic, messages: [{ key, value }] })
    },
  }
}
```

Add `kafkajs` to `apps/ingest-api/package.json` dependencies: `"kafkajs": "^2.2.4"`.

- [ ] **Step 2: Extend `AppDeps` with the producer**

Modify `apps/ingest-api/src/app.ts` — add `producer: EventProducer` to
`AppDeps` and import `EventProducer` from `./kafka/producer`.

- [ ] **Step 3: Write the failing integration test for the envelope route**

`apps/ingest-api/src/routes/envelope.test.ts`:
```ts
import { createDb } from '@flare/db'
import { Kafka } from 'kafkajs'
import Redis from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../app'
import { createKafkaProducer } from '../kafka/producer'

const brokers = [process.env.KAFKA_BROKERS ?? 'localhost:9092']
const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379')
const producer = createKafkaProducer(brokers)
const app = buildApp({ db, redis, producer })

let publicKey: string
let projectId: string

beforeAll(async () => {
  await producer.connect()
  publicKey = `pk-envelope-${Date.now()}`
  const inserted = await db
    .insertInto('project')
    .values({ name: 'Envelope Test', slug: `envelope-test-${Date.now()}`, public_key: publicKey })
    .returningAll()
    .executeTakeFirstOrThrow()
  projectId = inserted.id
})

afterAll(async () => {
  await producer.disconnect()
  await db.destroy()
  redis.disconnect()
  await app.close()
})

function envelopeBuffer(eventId: string): Buffer {
  const payload = JSON.stringify({
    event_id: eventId,
    environment: 'production',
    exception: { values: [{ type: 'Error', value: 'boom' }] },
  })
  const lines = [
    JSON.stringify({ event_id: eventId }),
    JSON.stringify({ type: 'event', length: Buffer.byteLength(payload) }),
    payload,
  ]
  return Buffer.from(lines.join('\n') + '\n')
}

describe('POST /api/:projectId/envelope/', () => {
  it('publishes an event item to Kafka and returns 200', async () => {
    const kafka = new Kafka({ clientId: 'test-consumer', brokers })
    const consumer = kafka.consumer({ groupId: `envelope-test-${Date.now()}` })
    await consumer.connect()
    await consumer.subscribe({ topic: 'ingest.errors', fromBeginning: true })

    const received: string[] = []
    const consumePromise = new Promise<void>((resolve) => {
      consumer.run({
        eachMessage: async ({ message }) => {
          received.push(message.value?.toString('utf8') ?? '')
          resolve()
        },
      })
    })

    const eventId = `event-${Date.now()}`
    const response = await app.inject({
      method: 'POST',
      url: `/api/${projectId}/envelope/`,
      headers: {
        'x-sentry-auth': `Sentry sentry_version=7, sentry_key=${publicKey}`,
        'content-type': 'application/x-sentry-envelope',
      },
      payload: envelopeBuffer(eventId),
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ id: eventId })

    await consumePromise
    await consumer.disconnect()

    expect(JSON.parse(received[0]).event_id).toBe(eventId)
  })

  it('returns 401 when the public key is unknown', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/${projectId}/envelope/`,
      headers: { 'x-sentry-auth': 'Sentry sentry_version=7, sentry_key=not-a-real-key' },
      payload: envelopeBuffer('irrelevant'),
    })
    expect(response.statusCode).toBe(401)
  })
})
```

- [ ] **Step 4: Run test to verify it fails**

Prerequisite: `docker compose up -d` (all services).

Run: `DATABASE_URL=postgres://flare:flare@localhost:5432/flare REDIS_URL=redis://localhost:6379 KAFKA_BROKERS=localhost:9092 pnpm --filter @flare/ingest-api test`
Expected: FAIL — route not registered (404 instead of 200/401)

- [ ] **Step 5: Implement the envelope route**

`apps/ingest-api/src/routes/envelope.ts`:
```ts
import type { FastifyInstance } from 'fastify'
import { SentryEventItemSchema } from '@flare/shared-types'
import { parseSentryAuthHeader } from '../auth/parse-sentry-auth-header'
import { resolveProjectByPublicKey } from '../auth/resolve-project'
import { checkRateLimit } from '../rate-limit/check-rate-limit'
import { parseEnvelope } from '../envelope/parse-envelope'

export function registerEnvelopeRoute(app: FastifyInstance): void {
  app.post<{ Params: { projectId: string } }>(
    '/api/:projectId/envelope/',
    { config: { rawBody: true } },
    async (request, reply) => {
      const { db, redis, producer } = app.deps

      const authHeader = request.headers['x-sentry-auth']
      const publicKey =
        parseSentryAuthHeader(Array.isArray(authHeader) ? authHeader[0] : authHeader) ??
        (typeof (request.query as { sentry_key?: string })?.sentry_key === 'string'
          ? (request.query as { sentry_key: string }).sentry_key
          : null)

      if (!publicKey) {
        return reply.code(401).send({ error: 'missing sentry_key' })
      }

      const project = await resolveProjectByPublicKey(publicKey, { db, redis })
      if (!project || project.id !== request.params.projectId) {
        return reply.code(401).send({ error: 'unknown project' })
      }

      const rateLimit = await checkRateLimit(redis, project.id, 'error')
      if (!rateLimit.allowed) {
        return reply
          .code(429)
          .header('Retry-After', String(rateLimit.retryAfterSeconds))
          .header('X-Sentry-Rate-Limits', `${rateLimit.retryAfterSeconds}:error:key`)
          .send()
      }

      const raw = request.body as Buffer
      const envelope = parseEnvelope(raw)

      let lastEventId: string | undefined
      for (const item of envelope.items) {
        if (item.header.type !== 'event') continue
        const parsed = SentryEventItemSchema.parse(JSON.parse(item.payload.toString('utf8')))
        lastEventId = parsed.event_id
        await producer.send('ingest.errors', `${project.id}:${parsed.event_id}`, JSON.stringify({
          projectId: project.id,
          event: parsed,
        }))
      }

      return reply.code(200).send({ id: lastEventId ?? envelope.header.event_id })
    }
  )
}
```

Register the route and a raw-body content-type parser in `app.ts`:
```ts
// in buildApp, before returning app:
app.addContentTypeParser(
  'application/x-sentry-envelope',
  { parseAs: 'buffer' },
  (_req, body, done) => done(null, body)
)
app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body))
registerEnvelopeRoute(app)
```
(import `registerEnvelopeRoute` from `./routes/envelope`)

Fastify's TypeScript types don't know about `app.deps` by default — declare
module augmentation in `app.ts`:
```ts
declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `DATABASE_URL=postgres://flare:flare@localhost:5432/flare REDIS_URL=redis://localhost:6379 KAFKA_BROKERS=localhost:9092 pnpm --filter @flare/ingest-api test`
Expected: PASS

- [ ] **Step 7: Wire the producer into `server.ts`**

Modify `apps/ingest-api/src/server.ts` to construct `createKafkaProducer`,
`await producer.connect()` before `app.listen`, and pass `producer` into
`buildApp`.

- [ ] **Step 8: Commit**

```bash
git add apps/ingest-api
git commit -m "feat(ingest-api): sentry-compatible envelope endpoint publishing to Kafka"
```

---

### Task 10: `resolveEnvironment` (shared by ingest path's future use and grouping-worker)

**Files:**
- Create: `packages/db/src/resolve-environment.ts`
- Test: `packages/db/src/resolve-environment.test.ts`
- Modify: `packages/db/src/index.ts` (create if absent — barrel export)

**Interfaces:**
- Consumes: `Database`, `createDb` (Task 3).
- Produces: `resolveEnvironment(db, redis, projectId, name): Promise<string>`
  (returns `environment_id`) — consumed by Task 14's grouping-worker
  handler.

- [ ] **Step 1: Write the failing test**

`packages/db/src/resolve-environment.test.ts`:
```ts
import Redis from 'ioredis'
import { afterAll, describe, expect, it } from 'vitest'
import { createDb } from './create-db'
import { resolveEnvironment } from './resolve-environment'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379')

afterAll(async () => {
  await db.destroy()
  redis.disconnect()
})

describe('resolveEnvironment', () => {
  it('creates the environment on first sighting and reuses it on the next call', async () => {
    const project = await db
      .insertInto('project')
      .values({ name: 'Env Test', slug: `env-test-${Date.now()}`, public_key: `pk-env-${Date.now()}` })
      .returningAll()
      .executeTakeFirstOrThrow()

    const firstId = await resolveEnvironment(db, redis, project.id, 'staging')
    const secondId = await resolveEnvironment(db, redis, project.id, 'staging')

    expect(firstId).toBe(secondId)

    const rows = await db
      .selectFrom('environment')
      .selectAll()
      .where('project_id', '=', project.id)
      .where('name', '=', 'staging')
      .execute()
    expect(rows).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL=postgres://flare:flare@localhost:5432/flare REDIS_URL=redis://localhost:6379 pnpm --filter @flare/db test`
Expected: FAIL — `Cannot find module './resolve-environment'`

- [ ] **Step 3: Implement `resolveEnvironment`**

`packages/db/src/resolve-environment.ts`:
```ts
import type { Kysely } from 'kysely'
import type { Redis } from 'ioredis'
import type { Database } from './schema'

const CACHE_TTL_SECONDS = 300

export async function resolveEnvironment(
  db: Kysely<Database>,
  redis: Redis,
  projectId: string,
  name: string
): Promise<string> {
  const cacheKey = `env:${projectId}:${name}`
  const cached = await redis.get(cacheKey)
  if (cached) return cached

  const inserted = await db
    .insertInto('environment')
    .values({ project_id: projectId, name })
    .onConflict((oc) => oc.columns(['project_id', 'name']).doNothing())
    .returning('id')
    .executeTakeFirst()

  const id =
    inserted?.id ??
    (
      await db
        .selectFrom('environment')
        .select('id')
        .where('project_id', '=', projectId)
        .where('name', '=', name)
        .executeTakeFirstOrThrow()
    ).id

  await redis.set(cacheKey, id, 'EX', CACHE_TTL_SECONDS)
  return id
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `DATABASE_URL=postgres://flare:flare@localhost:5432/flare REDIS_URL=redis://localhost:6379 pnpm --filter @flare/db test`
Expected: PASS

- [ ] **Step 5: Barrel export and commit**

`packages/db/src/index.ts`:
```ts
export * from './schema'
export * from './create-db'
export * from './resolve-environment'
```

Add `ioredis` to `packages/db/package.json` dependencies.

```bash
git add packages/db
git commit -m "feat(db): resolveEnvironment with redis-cached auto-create"
```

---

### Task 11: `grouping-worker` Skeleton + Kafka Consumer Wiring

**Files:**
- Create: `apps/grouping-worker/package.json`
- Create: `apps/grouping-worker/tsconfig.json`
- Create: `apps/grouping-worker/vitest.config.ts`
- Create: `apps/grouping-worker/src/consumer.ts`
- Create: `apps/grouping-worker/src/main.ts`
- Test: `apps/grouping-worker/src/consumer.test.ts`

**Interfaces:**
- Produces: `startConsumer(brokers, groupId, onMessage): Promise<() => Promise<void>>`
  (returns a stop function) — Task 14 supplies the real `onMessage`
  (`handleErrorMessage`); this task tests it with a stub handler.

- [ ] **Step 1: Package scaffold**

`apps/grouping-worker/package.json`:
```json
{
  "name": "@flare/grouping-worker",
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "lint": "echo 'no lint configured yet'",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "start": "node dist/main.js"
  },
  "dependencies": {
    "@flare/db": "workspace:*",
    "@flare/shared-types": "workspace:*",
    "ioredis": "^5.4.0",
    "kafkajs": "^2.2.4"
  },
  "devDependencies": {
    "vitest": "^2.1.0"
  }
}
```

`apps/grouping-worker/tsconfig.json` / `vitest.config.ts`: same shape as
Task 2's.

- [ ] **Step 2: Write the failing test**

`apps/grouping-worker/src/consumer.test.ts`:
```ts
import { Kafka } from 'kafkajs'
import { afterAll, describe, expect, it } from 'vitest'
import { startConsumer } from './consumer'

const brokers = [process.env.KAFKA_BROKERS ?? 'localhost:9092']

describe('startConsumer', () => {
  it('invokes onMessage for each message produced to the topic', async () => {
    const topic = `grouping-worker-test-${Date.now()}`
    const kafka = new Kafka({ clientId: 'test-producer', brokers })
    const producer = kafka.producer()
    await producer.connect()

    const received: string[] = []
    const stop = await startConsumer(brokers, `test-group-${Date.now()}`, topic, async (value) => {
      received.push(value.toString('utf8'))
    })

    await producer.send({ topic, messages: [{ value: 'hello-from-test' }] })

    await new Promise((resolve) => setTimeout(resolve, 2000))

    expect(received).toContain('hello-from-test')

    await producer.disconnect()
    await stop()
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Prerequisite: `docker compose up -d kafka`.

Run: `KAFKA_BROKERS=localhost:9092 pnpm --filter @flare/grouping-worker test`
Expected: FAIL — `Cannot find module './consumer'`

- [ ] **Step 4: Implement `startConsumer`**

`apps/grouping-worker/src/consumer.ts`:
```ts
import { Kafka } from 'kafkajs'

export type MessageHandler = (value: Buffer) => Promise<void>

export async function startConsumer(
  brokers: string[],
  groupId: string,
  topic: string,
  onMessage: MessageHandler
): Promise<() => Promise<void>> {
  const kafka = new Kafka({ clientId: 'grouping-worker', brokers })
  const consumer = kafka.consumer({ groupId })

  await consumer.connect()
  await consumer.subscribe({ topic, fromBeginning: true })

  await consumer.run({
    eachMessage: async ({ message }) => {
      if (message.value) await onMessage(message.value)
    },
  })

  return () => consumer.disconnect()
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `KAFKA_BROKERS=localhost:9092 pnpm --filter @flare/grouping-worker test`
Expected: PASS

- [ ] **Step 6: Entrypoint stub and commit**

`apps/grouping-worker/src/main.ts` (real handler wired in Task 14 — for
now, a placeholder that will be replaced, not committed as final):
```ts
import { startConsumer } from './consumer'

const brokers = [process.env.KAFKA_BROKERS ?? 'localhost:9092']

startConsumer(brokers, 'grouping-worker', 'ingest.errors', async (value) => {
  console.log('received message', value.toString('utf8'))
}).catch((error) => {
  console.error(error)
  process.exit(1)
})
```

```bash
git add apps/grouping-worker
git commit -m "feat(grouping-worker): kafka consumer skeleton"
```

---

### Task 12: Fingerprint Computation (pure)

**Files:**
- Create: `apps/grouping-worker/src/fingerprint.ts`
- Test: `apps/grouping-worker/src/fingerprint.test.ts`

**Interfaces:**
- Consumes: `SentryEventItem['exception']` type (Task 2).
- Produces: `computeFingerprint(exception): string` — consumed by Task 14.

- [ ] **Step 1: Write the failing test**

`apps/grouping-worker/src/fingerprint.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { computeFingerprint } from './fingerprint'

describe('computeFingerprint', () => {
  it('produces the same fingerprint for the same top in-app frames', () => {
    const exceptionA = {
      values: [
        {
          type: 'TypeError',
          stacktrace: {
            frames: [
              { filename: 'a.js', function: 'helper', in_app: false },
              { filename: 'app.js', function: 'main', in_app: true },
              { filename: 'app.js', function: 'handler', in_app: true },
            ],
          },
        },
      ],
    }
    const exceptionB = {
      values: [
        {
          type: 'TypeError',
          stacktrace: {
            frames: [
              { filename: 'app.js', function: 'main', in_app: true },
              { filename: 'app.js', function: 'handler', in_app: true },
            ],
          },
        },
      ],
    }

    expect(computeFingerprint(exceptionA)).toBe(computeFingerprint(exceptionB))
  })

  it('produces different fingerprints for different exception types', () => {
    const base = { stacktrace: { frames: [{ filename: 'app.js', function: 'main', in_app: true }] } }
    const fpA = computeFingerprint({ values: [{ type: 'TypeError', ...base }] })
    const fpB = computeFingerprint({ values: [{ type: 'RangeError', ...base }] })
    expect(fpA).not.toBe(fpB)
  })

  it('falls back to a stable fingerprint when there is no exception', () => {
    expect(computeFingerprint(undefined)).toBe(computeFingerprint(undefined))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flare/grouping-worker test`
Expected: FAIL — `Cannot find module './fingerprint'`

- [ ] **Step 3: Implement `computeFingerprint`**

`apps/grouping-worker/src/fingerprint.ts`:
```ts
import { createHash } from 'node:crypto'
import type { SentryEventItem } from '@flare/shared-types'

const TOP_N_FRAMES = 5

export function computeFingerprint(exception: SentryEventItem['exception']): string {
  const primary = exception?.values?.[0]
  if (!primary) {
    return createHash('sha1').update('no-exception').digest('hex')
  }

  const inAppFrames = (primary.stacktrace?.frames ?? [])
    .filter((frame) => frame.in_app !== false)
    .slice(-TOP_N_FRAMES)
    .map((frame) => `${frame.filename ?? ''}:${frame.function ?? ''}`)

  const basis = [primary.type ?? '', ...inAppFrames].join('|')
  return createHash('sha1').update(basis).digest('hex')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @flare/grouping-worker test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/grouping-worker/src/fingerprint.ts apps/grouping-worker/src/fingerprint.test.ts
git commit -m "feat(grouping-worker): fingerprint computation from in-app frames"
```

---

### Task 13: `upsertIssueAndEvent`

**Files:**
- Create: `apps/grouping-worker/src/upsert-issue-event.ts`
- Test: `apps/grouping-worker/src/upsert-issue-event.test.ts`

**Interfaces:**
- Consumes: `Database` (Task 3), `SentryEventItem` (Task 2).
- Produces: `UpsertResult` (`{ issueId: string; eventId: string; created: boolean }`),
  `upsertIssueAndEvent(db, params): Promise<UpsertResult>` — consumed by
  Task 14.

- [ ] **Step 1: Write the failing test**

`apps/grouping-worker/src/upsert-issue-event.test.ts`:
```ts
import { createDb } from '@flare/db'
import { afterAll, describe, expect, it } from 'vitest'
import { upsertIssueAndEvent } from './upsert-issue-event'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')

afterAll(() => db.destroy())

async function seedProjectAndEnvironment() {
  const project = await db
    .insertInto('project')
    .values({ name: 'Upsert Test', slug: `upsert-test-${Date.now()}`, public_key: `pk-upsert-${Date.now()}` })
    .returningAll()
    .executeTakeFirstOrThrow()
  const environment = await db
    .insertInto('environment')
    .values({ project_id: project.id, name: 'production' })
    .returningAll()
    .executeTakeFirstOrThrow()
  return { projectId: project.id, environmentId: environment.id }
}

describe('upsertIssueAndEvent', () => {
  it('creates a new issue and event on first occurrence', async () => {
    const { projectId, environmentId } = await seedProjectAndEnvironment()
    const event = { event_id: 'evt-1', environment: 'production', exception: { values: [{ type: 'Error', value: 'boom' }] } }

    const result = await upsertIssueAndEvent(db, {
      projectId,
      environmentId,
      fingerprint: 'fp-1',
      event,
    })

    expect(result.created).toBe(true)

    const issue = await db.selectFrom('issue').selectAll().where('id', '=', result.issueId).executeTakeFirstOrThrow()
    expect(issue.times_seen).toBe(1)
  })

  it('bumps times_seen and reuses the issue on a repeat fingerprint', async () => {
    const { projectId, environmentId } = await seedProjectAndEnvironment()
    const eventA = { event_id: 'evt-a', environment: 'production', exception: { values: [{ type: 'Error', value: 'boom' }] } }
    const eventB = { event_id: 'evt-b', environment: 'production', exception: { values: [{ type: 'Error', value: 'boom' }] } }

    const first = await upsertIssueAndEvent(db, { projectId, environmentId, fingerprint: 'fp-repeat', event: eventA })
    const second = await upsertIssueAndEvent(db, { projectId, environmentId, fingerprint: 'fp-repeat', event: eventB })

    expect(second.issueId).toBe(first.issueId)
    expect(second.created).toBe(false)

    const issue = await db.selectFrom('issue').selectAll().where('id', '=', first.issueId).executeTakeFirstOrThrow()
    expect(issue.times_seen).toBe(2)

    const issueEnv = await db
      .selectFrom('issue_environment')
      .selectAll()
      .where('issue_id', '=', first.issueId)
      .where('environment_id', '=', environmentId)
      .executeTakeFirstOrThrow()
    expect(issueEnv.times_seen).toBe(2)
  })

  it('is idempotent on repeated event_id (Kafka at-least-once retry)', async () => {
    const { projectId, environmentId } = await seedProjectAndEnvironment()
    const event = { event_id: 'evt-retry', environment: 'production', exception: { values: [{ type: 'Error', value: 'boom' }] } }

    await upsertIssueAndEvent(db, { projectId, environmentId, fingerprint: 'fp-retry', event })
    await upsertIssueAndEvent(db, { projectId, environmentId, fingerprint: 'fp-retry', event })

    const events = await db
      .selectFrom('event')
      .selectAll()
      .where('project_id', '=', projectId)
      .where('event_id', '=', 'evt-retry')
      .execute()
    expect(events).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL=postgres://flare:flare@localhost:5432/flare pnpm --filter @flare/grouping-worker test`
Expected: FAIL — `Cannot find module './upsert-issue-event'`

- [ ] **Step 3: Implement `upsertIssueAndEvent`**

`apps/grouping-worker/src/upsert-issue-event.ts`:
```ts
import type { Kysely } from 'kysely'
import type { Database } from '@flare/db'
import type { SentryEventItem } from '@flare/shared-types'
import { sql } from 'kysely'

export interface UpsertResult {
  issueId: string
  eventId: string
  created: boolean
}

function titleFrom(event: SentryEventItem): string {
  const primary = event.exception?.values?.[0]
  if (primary) return `${primary.type ?? 'Error'}: ${primary.value ?? ''}`.trim()
  return event.message ?? 'Unknown error'
}

function culpritFrom(event: SentryEventItem): string | null {
  const frame = event.exception?.values?.[0]?.stacktrace?.frames?.slice(-1)[0]
  if (!frame) return null
  return `${frame.function ?? '?'} in ${frame.filename ?? '?'}`
}

export async function upsertIssueAndEvent(
  db: Kysely<Database>,
  params: {
    projectId: string
    environmentId: string
    fingerprint: string
    event: SentryEventItem
  }
): Promise<UpsertResult> {
  const { projectId, environmentId, fingerprint, event } = params

  return db.transaction().execute(async (trx) => {
    const existingIssue = await trx
      .selectFrom('issue')
      .select('id')
      .where('project_id', '=', projectId)
      .where('fingerprint', '=', fingerprint)
      .executeTakeFirst()

    const issue = existingIssue
      ? await trx
          .updateTable('issue')
          .set({ last_seen: new Date(), times_seen: sql`times_seen + 1` })
          .where('id', '=', existingIssue.id)
          .returning('id')
          .executeTakeFirstOrThrow()
      : await trx
          .insertInto('issue')
          .values({
            project_id: projectId,
            fingerprint,
            title: titleFrom(event),
            culprit: culpritFrom(event),
            grouping_raw_components: JSON.stringify(event.exception ?? {}),
          })
          .returning('id')
          .executeTakeFirstOrThrow()

    await trx
      .insertInto('issue_environment')
      .values({ issue_id: issue.id, environment_id: environmentId })
      .onConflict((oc) =>
        oc
          .columns(['issue_id', 'environment_id'])
          .doUpdateSet({ last_seen: new Date(), times_seen: sql`issue_environment.times_seen + 1` })
      )
      .execute()

    const insertedEvent = await trx
      .insertInto('event')
      .values({
        project_id: projectId,
        issue_id: issue.id,
        environment_id: environmentId,
        event_id: event.event_id,
        timestamp: event.timestamp ? new Date(event.timestamp) : new Date(),
        level: event.level ?? null,
        message: event.message ?? null,
        exception: JSON.stringify(event.exception ?? null),
      })
      .onConflict((oc) => oc.columns(['project_id', 'event_id']).doNothing())
      .returning('id')
      .executeTakeFirst()

    return {
      issueId: issue.id,
      eventId: insertedEvent?.id ?? event.event_id,
      created: !existingIssue,
    }
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `DATABASE_URL=postgres://flare:flare@localhost:5432/flare pnpm --filter @flare/grouping-worker test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/grouping-worker/src/upsert-issue-event.ts apps/grouping-worker/src/upsert-issue-event.test.ts
git commit -m "feat(grouping-worker): idempotent issue/event upsert"
```

---

### Task 14: `handleErrorMessage` — Full Pipeline Wiring

**Files:**
- Create: `apps/grouping-worker/src/handle-message.ts`
- Modify: `apps/grouping-worker/src/main.ts`
- Test: `apps/grouping-worker/src/handle-message.test.ts`

**Interfaces:**
- Consumes: `resolveEnvironment` (Task 10), `computeFingerprint` (Task 12),
  `upsertIssueAndEvent` (Task 13), `SentryEventItemSchema` (Task 2).
- Produces: `handleErrorMessage(db, redis, rawValue: Buffer): Promise<void>`
  — wired into `startConsumer` in `main.ts`; this is the end of the ingest
  → grouping pipeline for Phase 1.

- [ ] **Step 1: Write the failing end-to-end test (ingest-api's own message shape → grouping-worker → Postgres)**

`apps/grouping-worker/src/handle-message.test.ts`:
```ts
import { createDb } from '@flare/db'
import Redis from 'ioredis'
import { afterAll, describe, expect, it } from 'vitest'
import { handleErrorMessage } from './handle-message'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379')

afterAll(async () => {
  await db.destroy()
  redis.disconnect()
})

describe('handleErrorMessage', () => {
  it('resolves the environment, groups, and persists the event from a raw Kafka message', async () => {
    const project = await db
      .insertInto('project')
      .values({ name: 'Handle Msg Test', slug: `handle-msg-${Date.now()}`, public_key: `pk-handle-${Date.now()}` })
      .returningAll()
      .executeTakeFirstOrThrow()

    const rawMessage = Buffer.from(
      JSON.stringify({
        projectId: project.id,
        event: {
          event_id: `evt-handle-${Date.now()}`,
          environment: 'staging',
          exception: { values: [{ type: 'TypeError', value: 'boom', stacktrace: { frames: [{ filename: 'app.js', function: 'main', in_app: true }] } }] },
        },
      })
    )

    await handleErrorMessage(db, redis, rawMessage)

    const environment = await db
      .selectFrom('environment')
      .selectAll()
      .where('project_id', '=', project.id)
      .where('name', '=', 'staging')
      .executeTakeFirstOrThrow()

    const issues = await db.selectFrom('issue').selectAll().where('project_id', '=', project.id).execute()
    expect(issues).toHaveLength(1)
    expect(issues[0].title).toContain('TypeError')

    const issueEnv = await db
      .selectFrom('issue_environment')
      .selectAll()
      .where('issue_id', '=', issues[0].id)
      .where('environment_id', '=', environment.id)
      .executeTakeFirstOrThrow()
    expect(issueEnv.times_seen).toBe(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL=postgres://flare:flare@localhost:5432/flare REDIS_URL=redis://localhost:6379 pnpm --filter @flare/grouping-worker test`
Expected: FAIL — `Cannot find module './handle-message'`

- [ ] **Step 3: Implement `handleErrorMessage`**

`apps/grouping-worker/src/handle-message.ts`:
```ts
import type { Kysely } from 'kysely'
import type { Database } from '@flare/db'
import { resolveEnvironment } from '@flare/db'
import type { Redis } from 'ioredis'
import { SentryEventItemSchema } from '@flare/shared-types'
import { computeFingerprint } from './fingerprint'
import { upsertIssueAndEvent } from './upsert-issue-event'

interface IngestErrorMessage {
  projectId: string
  event: unknown
}

export async function handleErrorMessage(db: Kysely<Database>, redis: Redis, rawValue: Buffer): Promise<void> {
  const parsed = JSON.parse(rawValue.toString('utf8')) as IngestErrorMessage
  const event = SentryEventItemSchema.parse(parsed.event)

  const environmentId = await resolveEnvironment(db, redis, parsed.projectId, event.environment)
  const fingerprint = computeFingerprint(event.exception)

  await upsertIssueAndEvent(db, {
    projectId: parsed.projectId,
    environmentId,
    fingerprint,
    event,
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `DATABASE_URL=postgres://flare:flare@localhost:5432/flare REDIS_URL=redis://localhost:6379 pnpm --filter @flare/grouping-worker test`
Expected: PASS

- [ ] **Step 5: Wire into `main.ts`**

`apps/grouping-worker/src/main.ts`:
```ts
import { createDb } from '@flare/db'
import Redis from 'ioredis'
import { startConsumer } from './consumer'
import { handleErrorMessage } from './handle-message'

const brokers = [process.env.KAFKA_BROKERS ?? 'localhost:9092']
const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379')

startConsumer(brokers, 'grouping-worker', 'ingest.errors', (value) => handleErrorMessage(db, redis, value)).catch(
  (error) => {
    console.error(error)
    process.exit(1)
  }
)
```

- [ ] **Step 6: Run the full ingest→grouping pipeline manually to confirm the wiring end-to-end**

Prerequisite: `docker compose up -d`, and in separate terminals:
`pnpm --filter @flare/grouping-worker exec node --loader ts-node/esm src/main.ts`
and `pnpm --filter @flare/ingest-api exec node --loader ts-node/esm src/server.ts`.

Run:
```bash
curl -i -X POST http://localhost:3000/api/<projectId>/envelope/ \
  -H "x-sentry-auth: Sentry sentry_version=7, sentry_key=<publicKey>" \
  -H "content-type: application/x-sentry-envelope" \
  --data-binary @- <<'EOF'
{"event_id":"manual-1"}
{"type":"event","length":94}
{"event_id":"manual-1","environment":"production","exception":{"values":[{"type":"Error","value":"manual test"}]}}
EOF
```
Expected: `200 {"id":"manual-1"}`, and a row appears in `issue`/`event` for
that project (verify with `psql` or a quick Kysely query).

- [ ] **Step 7: Commit**

```bash
git add apps/grouping-worker
git commit -m "feat(grouping-worker): wire envelope->environment->fingerprint->upsert pipeline"
```

---

### Task 15: `query-api` — Issue List, Detail, Events Endpoints

**Files:**
- Create: `apps/query-api/package.json`
- Create: `apps/query-api/tsconfig.json`
- Create: `apps/query-api/vitest.config.ts`
- Create: `apps/query-api/src/app.ts`
- Create: `apps/query-api/src/routes/issues.ts`
- Create: `apps/query-api/src/server.ts`
- Test: `apps/query-api/src/routes/issues.test.ts`

**Interfaces:**
- Consumes: `Database`, `createDb` (Task 3), `IssueSummarySchema`,
  `IssueDetailSchema` (Task 2).
- Produces: HTTP routes `GET /api/v1/projects/:projectId/issues`,
  `GET /api/v1/issues/:issueId`, `GET /api/v1/issues/:issueId/events` —
  consumed by Task 16's web app.

- [ ] **Step 1: Package scaffold**

`apps/query-api/package.json`:
```json
{
  "name": "@flare/query-api",
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "lint": "echo 'no lint configured yet'",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "start": "node dist/server.js"
  },
  "dependencies": {
    "@flare/db": "workspace:*",
    "@flare/shared-types": "workspace:*",
    "fastify": "^4.28.0",
    "@fastify/cors": "^9.0.0"
  },
  "devDependencies": {
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Write the failing test**

`apps/query-api/src/routes/issues.test.ts`:
```ts
import { createDb } from '@flare/db'
import { afterAll, describe, expect, it } from 'vitest'
import { buildApp } from '../app'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')
const app = buildApp({ db })

afterAll(async () => {
  await db.destroy()
  await app.close()
})

async function seedIssueWithEvent() {
  const project = await db
    .insertInto('project')
    .values({ name: 'Query Test', slug: `query-test-${Date.now()}`, public_key: `pk-query-${Date.now()}` })
    .returningAll()
    .executeTakeFirstOrThrow()
  const environment = await db
    .insertInto('environment')
    .values({ project_id: project.id, name: 'production' })
    .returningAll()
    .executeTakeFirstOrThrow()
  const issue = await db
    .insertInto('issue')
    .values({
      project_id: project.id,
      fingerprint: `fp-query-${Date.now()}`,
      title: 'TypeError: boom',
      culprit: 'main in app.js',
      grouping_raw_components: '{}',
    })
    .returningAll()
    .executeTakeFirstOrThrow()
  await db
    .insertInto('event')
    .values({
      project_id: project.id,
      issue_id: issue.id,
      environment_id: environment.id,
      event_id: `evt-query-${Date.now()}`,
      timestamp: new Date(),
      message: 'boom',
      exception: '{}',
    })
    .execute()
  return { project, issue }
}

describe('GET /api/v1/projects/:projectId/issues', () => {
  it('lists issues for the project', async () => {
    const { project, issue } = await seedIssueWithEvent()

    const response = await app.inject({ method: 'GET', url: `/api/v1/projects/${project.id}/issues` })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.some((row: { id: string }) => row.id === issue.id)).toBe(true)
  })
})

describe('GET /api/v1/issues/:issueId', () => {
  it('returns issue detail with its events', async () => {
    const { issue } = await seedIssueWithEvent()

    const response = await app.inject({ method: 'GET', url: `/api/v1/issues/${issue.id}` })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.id).toBe(issue.id)
    expect(body.events.length).toBeGreaterThan(0)
  })

  it('returns 404 for an unknown issue', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/issues/00000000-0000-0000-0000-000000000000' })
    expect(response.statusCode).toBe(404)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `DATABASE_URL=postgres://flare:flare@localhost:5432/flare pnpm --filter @flare/query-api test`
Expected: FAIL — `Cannot find module '../app'`

- [ ] **Step 4: Implement `buildApp` and the routes**

`apps/query-api/src/app.ts`:
```ts
import Fastify, { type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import type { Kysely } from 'kysely'
import type { Database } from '@flare/db'
import { registerIssueRoutes } from './routes/issues'

export interface AppDeps {
  db: Kysely<Database>
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps
  }
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: true })
  app.decorate('deps', deps)
  app.register(cors, { origin: true })

  app.get('/healthz', async () => ({ status: 'ok' }))
  registerIssueRoutes(app)

  return app
}
```

`apps/query-api/src/routes/issues.ts`:
```ts
import type { FastifyInstance } from 'fastify'
import type { IssueDetail, IssueSummary } from '@flare/shared-types'

export function registerIssueRoutes(app: FastifyInstance): void {
  app.get<{ Params: { projectId: string } }>(
    '/api/v1/projects/:projectId/issues',
    async (request) => {
      const rows = await app.deps.db
        .selectFrom('issue')
        .selectAll()
        .where('project_id', '=', request.params.projectId)
        .orderBy('last_seen', 'desc')
        .execute()

      const summaries: IssueSummary[] = rows.map((row) => ({
        id: row.id,
        title: row.title,
        culprit: row.culprit,
        status: row.status,
        timesSeen: row.times_seen,
        firstSeen: row.first_seen.toISOString(),
        lastSeen: row.last_seen.toISOString(),
      }))
      return summaries
    }
  )

  app.get<{ Params: { issueId: string } }>('/api/v1/issues/:issueId', async (request, reply) => {
    const issue = await app.deps.db
      .selectFrom('issue')
      .selectAll()
      .where('id', '=', request.params.issueId)
      .executeTakeFirst()

    if (!issue) return reply.code(404).send({ error: 'not found' })

    const events = await app.deps.db
      .selectFrom('event')
      .selectAll()
      .where('issue_id', '=', issue.id)
      .orderBy('timestamp', 'desc')
      .limit(50)
      .execute()

    const detail: IssueDetail = {
      id: issue.id,
      title: issue.title,
      culprit: issue.culprit,
      status: issue.status,
      timesSeen: issue.times_seen,
      firstSeen: issue.first_seen.toISOString(),
      lastSeen: issue.last_seen.toISOString(),
      events: events.map((event) => ({
        id: event.id,
        timestamp: event.timestamp.toISOString(),
        message: event.message,
        exception: event.exception,
      })),
    }
    return detail
  })
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `DATABASE_URL=postgres://flare:flare@localhost:5432/flare pnpm --filter @flare/query-api test`
Expected: PASS

- [ ] **Step 6: Entrypoint and commit**

`apps/query-api/src/server.ts`:
```ts
import { createDb } from '@flare/db'
import { buildApp } from './app'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')
const app = buildApp({ db })

app.listen({ port: Number(process.env.PORT ?? 3001), host: '0.0.0.0' }).catch((error) => {
  app.log.error(error)
  process.exit(1)
})
```

```bash
git add apps/query-api
git commit -m "feat(query-api): issue list, detail, and events endpoints"
```

---

### Task 16: `web` — Issue List and Detail Pages

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/vite.config.ts`
- Create: `apps/web/vitest.config.ts`
- Create: `apps/web/index.html`
- Create: `apps/web/src/main.tsx`
- Create: `apps/web/src/App.tsx`
- Create: `apps/web/src/api/query-client.ts`
- Create: `apps/web/src/pages/IssueListPage.tsx`
- Create: `apps/web/src/pages/IssueDetailPage.tsx`
- Test: `apps/web/src/api/query-client.test.ts`
- Test: `apps/web/src/pages/IssueListPage.test.tsx`

**Interfaces:**
- Consumes: `IssueSummary`, `IssueDetail` (Task 2), the `query-api` routes
  (Task 15).
- Produces: `fetchIssues(projectId): Promise<IssueSummary[]>`,
  `fetchIssue(issueId): Promise<IssueDetail>`.

- [ ] **Step 1: Package scaffold**

`apps/web/package.json`:
```json
{
  "name": "@flare/web",
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json && vite build",
    "test": "vitest run",
    "lint": "echo 'no lint configured yet'",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "dev": "vite"
  },
  "dependencies": {
    "@flare/shared-types": "workspace:*",
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "react-router-dom": "^6.26.0"
  },
  "devDependencies": {
    "@testing-library/react": "^16.0.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "jsdom": "^25.0.0",
    "msw": "^2.4.0",
    "vite": "^5.4.0",
    "vitest": "^2.1.0"
  }
}
```

`apps/web/vite.config.ts`:
```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({ plugins: [react()] })
```

`apps/web/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: { environment: 'jsdom', globals: true },
})
```

`apps/web/index.html`:
```html
<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>Flare</title></head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: Write the failing test for the API client**

`apps/web/src/api/query-client.test.ts`:
```ts
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { fetchIssue, fetchIssues } from './query-client'

const server = setupServer(
  http.get('http://localhost:3001/api/v1/projects/proj-1/issues', () =>
    HttpResponse.json([
      { id: 'issue-1', title: 'TypeError: boom', culprit: null, status: 'unresolved', timesSeen: 3, firstSeen: '2026-09-01T00:00:00.000Z', lastSeen: '2026-09-15T00:00:00.000Z' },
    ])
  ),
  http.get('http://localhost:3001/api/v1/issues/issue-1', () =>
    HttpResponse.json({
      id: 'issue-1',
      title: 'TypeError: boom',
      culprit: null,
      status: 'unresolved',
      timesSeen: 3,
      firstSeen: '2026-09-01T00:00:00.000Z',
      lastSeen: '2026-09-15T00:00:00.000Z',
      events: [],
    })
  )
)

beforeAll(() => server.listen())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('fetchIssues', () => {
  it('returns the parsed issue list', async () => {
    const issues = await fetchIssues('proj-1')
    expect(issues).toHaveLength(1)
    expect(issues[0].title).toBe('TypeError: boom')
  })
})

describe('fetchIssue', () => {
  it('returns issue detail', async () => {
    const issue = await fetchIssue('issue-1')
    expect(issue.id).toBe('issue-1')
    expect(issue.events).toEqual([])
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @flare/web test`
Expected: FAIL — `Cannot find module './query-client'`

- [ ] **Step 4: Implement the API client**

`apps/web/src/api/query-client.ts`:
```ts
import { IssueDetailSchema, IssueSummarySchema, type IssueDetail, type IssueSummary } from '@flare/shared-types'

const QUERY_API_BASE_URL = import.meta.env.VITE_QUERY_API_URL ?? 'http://localhost:3001'

export async function fetchIssues(projectId: string): Promise<IssueSummary[]> {
  const response = await fetch(`${QUERY_API_BASE_URL}/api/v1/projects/${projectId}/issues`)
  const body = await response.json()
  return IssueSummarySchema.array().parse(body)
}

export async function fetchIssue(issueId: string): Promise<IssueDetail> {
  const response = await fetch(`${QUERY_API_BASE_URL}/api/v1/issues/${issueId}`)
  const body = await response.json()
  return IssueDetailSchema.parse(body)
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @flare/web test`
Expected: PASS

- [ ] **Step 6: Write the failing test for the issue list page**

`apps/web/src/pages/IssueListPage.test.tsx`:
```tsx
import { render, screen, waitFor } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { MemoryRouter } from 'react-router-dom'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { IssueListPage } from './IssueListPage'

const server = setupServer(
  http.get('http://localhost:3001/api/v1/projects/proj-1/issues', () =>
    HttpResponse.json([
      { id: 'issue-1', title: 'TypeError: boom', culprit: 'main in app.js', status: 'unresolved', timesSeen: 3, firstSeen: '2026-09-01T00:00:00.000Z', lastSeen: '2026-09-15T00:00:00.000Z' },
    ])
  )
)

beforeAll(() => server.listen())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('IssueListPage', () => {
  it('renders the fetched issue title', async () => {
    render(
      <MemoryRouter>
        <IssueListPage projectId="proj-1" />
      </MemoryRouter>
    )

    await waitFor(() => expect(screen.getByText('TypeError: boom')).toBeInTheDocument())
    expect(screen.getByText('main in app.js')).toBeInTheDocument()
  })
})
```

- [ ] **Step 7: Run test to verify it fails**

Run: `pnpm --filter @flare/web test`
Expected: FAIL — `Cannot find module './IssueListPage'`

- [ ] **Step 8: Implement `IssueListPage` and `IssueDetailPage`**

`apps/web/src/pages/IssueListPage.tsx`:
```tsx
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { IssueSummary } from '@flare/shared-types'
import { fetchIssues } from '../api/query-client'

export function IssueListPage({ projectId }: { projectId: string }) {
  const [issues, setIssues] = useState<IssueSummary[]>([])

  useEffect(() => {
    fetchIssues(projectId).then(setIssues)
  }, [projectId])

  return (
    <ul>
      {issues.map((issue) => (
        <li key={issue.id}>
          <Link to={`/issues/${issue.id}`}>{issue.title}</Link>
          {issue.culprit && <span> — {issue.culprit}</span>}
          <span> ({issue.timesSeen})</span>
        </li>
      ))}
    </ul>
  )
}
```

`apps/web/src/pages/IssueDetailPage.tsx`:
```tsx
import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import type { IssueDetail } from '@flare/shared-types'
import { fetchIssue } from '../api/query-client'

export function IssueDetailPage() {
  const { issueId } = useParams<{ issueId: string }>()
  const [issue, setIssue] = useState<IssueDetail | null>(null)

  useEffect(() => {
    if (issueId) fetchIssue(issueId).then(setIssue)
  }, [issueId])

  if (!issue) return <p>Loading…</p>

  return (
    <div>
      <h1>{issue.title}</h1>
      <p>{issue.culprit}</p>
      <p>Status: {issue.status}</p>
      <ul>
        {issue.events.map((event) => (
          <li key={event.id}>
            <code>{JSON.stringify(event.exception)}</code>
          </li>
        ))}
      </ul>
    </div>
  )
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: `pnpm --filter @flare/web test`
Expected: PASS

- [ ] **Step 10: Wire routing and commit**

`apps/web/src/App.tsx`:
```tsx
import { Route, Routes } from 'react-router-dom'
import { IssueDetailPage } from './pages/IssueDetailPage'
import { IssueListPage } from './pages/IssueListPage'

const PROJECT_ID = import.meta.env.VITE_PROJECT_ID ?? ''

export function App() {
  return (
    <Routes>
      <Route path="/" element={<IssueListPage projectId={PROJECT_ID} />} />
      <Route path="/issues/:issueId" element={<IssueDetailPage />} />
    </Routes>
  )
}
```

`apps/web/src/main.tsx`:
```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { App } from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>
)
```

```bash
git add apps/web
git commit -m "feat(web): issue list and detail pages"
```

---

### Task 17: CI Pipeline

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: every `package.json`'s `build`/`test`/`lint`/`typecheck`
  scripts (all prior tasks) and `docker-compose.yml` (Task 4).

- [ ] **Step 1: Write the workflow**

`.github/workflows/ci.yml`:
```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with: { version: 9 }

      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }

      - run: pnpm install --frozen-lockfile

      - name: Start local dev stack
        run: docker compose up -d

      - name: Wait for Postgres and Redis
        run: |
          until docker compose exec -T postgres pg_isready -U flare; do sleep 2; done
          until docker compose exec -T redis redis-cli ping; do sleep 2; done

      - name: Run migrations
        run: pnpm --filter @flare/db migrate:up
        env:
          DATABASE_URL: postgres://flare:flare@localhost:5432/flare

      - run: pnpm turbo run lint typecheck build test
        env:
          DATABASE_URL: postgres://flare:flare@localhost:5432/flare
          REDIS_URL: redis://localhost:6379
          KAFKA_BROKERS: localhost:9092

      - name: Tear down
        if: always()
        run: docker compose down -v
```

- [ ] **Step 2: Verify locally that the same command sequence passes**

Run (from repo root, with nothing else running on those ports):
```bash
docker compose up -d
until docker compose exec -T postgres pg_isready -U flare; do sleep 2; done
DATABASE_URL=postgres://flare:flare@localhost:5432/flare pnpm --filter @flare/db migrate:up
DATABASE_URL=postgres://flare:flare@localhost:5432/flare REDIS_URL=redis://localhost:6379 KAFKA_BROKERS=localhost:9092 pnpm turbo run lint typecheck build test
```
Expected: all tasks across all packages pass, exit 0.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: run lint, typecheck, build, and test against docker compose services"
```

---

## Verification (end-to-end, after all 17 tasks)

1. `docker compose up -d` — all four services healthy.
2. `DATABASE_URL=... pnpm --filter @flare/db migrate:up` — five tables
   created with no errors.
3. `pnpm turbo run test` — every package's suite passes against the real
   Postgres/Redis/Kafka from compose (per the Global Constraints, nothing
   here is mocked).
4. Start `ingest-api`, `grouping-worker`, and `query-api` (`pnpm --filter
   <pkg> exec tsx src/server.ts` / `src/main.ts`), seed a project row
   directly via `psql`, send a real envelope with `curl` (Task 14 Step 6),
   and confirm the issue shows up via `curl
   http://localhost:3001/api/v1/projects/<id>/issues`.
5. `pnpm --filter @flare/web dev`, open the browser, confirm the issue
   list renders and clicking through to detail shows the exception.
6. This satisfies Phase 1's exit criteria from the architecture plan:
   unmodified Sentry SDK traffic → grouped issues → visible in a web UI,
   with environment auto-create and per-environment tracking working
   end-to-end.

## Note on the spec reference

This plan's `Spec:` line points at
`docs/superpowers/plans/flare-technical-plan.md`. That file does not exist
yet in this repo — the approved architecture plan currently lives only at
`C:\Users\damilola.sanda\.claude\plans\bubbly-wobbling-flamingo.md` (the
plan-mode scratch location). Before starting Task 1, copy that file's
content into `docs/superpowers/plans/flare-technical-plan.md` and commit it
first, so the spec travels with the repo rather than living only in a
local, non-versioned path.
