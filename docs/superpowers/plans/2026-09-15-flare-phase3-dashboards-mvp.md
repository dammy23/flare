# Flare Phase 3 (Dashboards MVP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One auto-provisioned dashboard per project with the starter
widget catalog (`issues_over_time`, `top_issues`, `new_issues`,
`events_by_environment`), a generic widget-data endpoint with a
short-TTL Redis cache, a dashboard-level environment selector with
per-widget inherit/pin, and a `react-grid-layout` web UI.

**Architecture:** `query-api` gains project creation (which
auto-provisions the dashboard), dashboard/widget CRUD, and a generic
`/widgets/:id/data` endpoint that dispatches to one vetted query function
per widget type — no raw user SQL anywhere. `web` gains a dashboard page
using `react-grid-layout` for the grid and `recharts` for the four
starter chart shapes.

**Tech Stack:** builds on Phases 0–2. Adds `react-grid-layout`,
`recharts` (web); no new backend libraries — `query-api` already has
Kysely/Fastify/Redis access patterns established in Phase 1.

**Spec:** [docs/superpowers/plans/flare-technical-plan.md](../flare-technical-plan.md)
§9 (Per-Project Dashboards).

## Global Constraints

Same as prior phases, plus:
- Every widget's backing query is a named, parameterized function this
  plan owns — `runWidgetQuery(db, type, config, scope)` dispatches to one
  of exactly four functions. No endpoint accepts or interpolates raw SQL.
- `dashboard.project_id` is `UNIQUE` — one dashboard per project for this
  phase, matching the architecture plan's explicit MVP scope (the escape
  hatch to multiple dashboards is dropping that constraint later, not
  built now).
- **Deviation from the architecture plan's column naming, made here and
  flagged rather than silently applied:** the architecture doc's data
  model has `dashboard_widget.pinned_environment_id` as an `environment`
  FK. This plan uses `pinned_environment_name: text | null` (and
  `dashboard.env_selector_default: text | null`) instead — an environment
  name, not a foreign key. Reason: a freshly auto-provisioned dashboard is
  created before any event has ever arrived for the project, so no
  `environment` row exists yet to reference; an FK would either force a
  bogus row into existence or make provisioning fail. A name-based filter
  degrades gracefully (matches nothing until the environment is actually
  seen) and costs nothing at this scale.
- No rollup table (`issue_rollup_daily`) in this phase. The architecture
  plan calls for one, but populating it correctly requires touching
  `grouping-worker`'s write path again and there's no way to prove
  incremental-maintenance correctness against real volume in this
  sandbox. Widget queries read `issue`/`issue_environment`/`event`
  directly instead — identical results at this volume, and the existing
  Phase 1 indexes (`issue(project_id, status, last_seen)`,
  `event(project_id, issue_id, timestamp)`) already cover them. Add the
  rollup table as its own task, with a real load test to justify it,
  whenever query latency at higher volume actually demands it — not
  speculatively now.

---

### Task 1: `dashboard` + `dashboard_widget` Tables

**Files:**
- Create: `packages/db/migrations/1700000000009_create-dashboard.cjs`
- Create: `packages/db/migrations/1700000000010_create-dashboard-widget.cjs`
- Modify: `packages/db/src/schema.ts`

**Interfaces:**
- Produces: `DashboardTable`, `DashboardWidgetTable`, `WidgetEnvironmentMode`
  (`'inherit' | 'pin'`) — consumed by every later task.

- [ ] **Step 1: Migrations**

`packages/db/migrations/1700000000009_create-dashboard.cjs`:
```js
exports.up = (pgm) => {
  pgm.createTable('dashboard', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    project_id: { type: 'uuid', notNull: true, references: 'project', onDelete: 'CASCADE' },
    name: { type: 'text', notNull: true, default: 'Default' },
    env_selector_default: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint('dashboard', 'dashboard_project_id_unique', 'UNIQUE(project_id)')
}
exports.down = (pgm) => pgm.dropTable('dashboard')
```

`packages/db/migrations/1700000000010_create-dashboard-widget.cjs`:
```js
exports.up = (pgm) => {
  pgm.createTable('dashboard_widget', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    dashboard_id: { type: 'uuid', notNull: true, references: 'dashboard', onDelete: 'CASCADE' },
    widget_type: { type: 'text', notNull: true },
    title: { type: 'text', notNull: true },
    layout: { type: 'jsonb', notNull: true },
    config: { type: 'jsonb', notNull: true, default: '{}' },
    environment_mode: { type: 'text', notNull: true, default: 'inherit' },
    pinned_environment_name: { type: 'text' },
    layout_updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    config_updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint(
    'dashboard_widget',
    'dashboard_widget_environment_mode_check',
    "CHECK (environment_mode IN ('inherit', 'pin'))"
  )
  pgm.createIndex('dashboard_widget', ['dashboard_id'])
}
exports.down = (pgm) => pgm.dropTable('dashboard_widget')
```

- [ ] **Step 2: Update `Database` schema**

Add to `packages/db/src/schema.ts`:
```ts
export type WidgetEnvironmentMode = 'inherit' | 'pin'

export interface DashboardTable {
  id: Generated<string>
  project_id: string
  name: Generated<string>
  env_selector_default: string | null
  created_at: Generated<Date>
}

export interface DashboardWidgetTable {
  id: Generated<string>
  dashboard_id: string
  widget_type: string
  title: string
  layout: unknown
  config: Generated<unknown>
  environment_mode: Generated<WidgetEnvironmentMode>
  pinned_environment_name: string | null
  layout_updated_at: Generated<Date>
  config_updated_at: Generated<Date>
}
```
Add `dashboard: DashboardTable` and `dashboard_widget: DashboardWidgetTable`
to the `Database` interface.

- [ ] **Step 3: Typecheck and commit**

Run: `pnpm --filter @flare/db typecheck` — expect clean.

```bash
git add packages/db
git commit -m "feat(db): dashboard and dashboard_widget tables"
```

---

### Task 2: Widget-Catalog Shared Types

**Files:**
- Create: `packages/shared-types/src/widgets.ts`
- Test: `packages/shared-types/src/widgets.test.ts`
- Modify: `packages/shared-types/src/index.ts`

**Interfaces:**
- Produces: `WidgetTypeSchema`/`WidgetType`, one config schema per widget
  type, `WidgetConfigSchemaByType` (a `Record<WidgetType, ZodSchema>`),
  `validateWidgetConfig(type, config): unknown`, `WidgetLayoutSchema`/
  `WidgetLayout` — this is the literal shared-type mechanism the
  architecture plan calls for: the same schema instances back both the
  server-side route validators (Task 7) and, eventually, a React config
  form. Consumed by every later task in this plan.

- [ ] **Step 1: Write the failing test**

`packages/shared-types/src/widgets.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { validateWidgetConfig, WidgetLayoutSchema, WidgetTypeSchema } from './widgets'

describe('WidgetTypeSchema', () => {
  it('accepts the four starter catalog types', () => {
    for (const type of ['issues_over_time', 'top_issues', 'new_issues', 'events_by_environment']) {
      expect(WidgetTypeSchema.parse(type)).toBe(type)
    }
  })

  it('rejects a widget type outside the catalog', () => {
    expect(() => WidgetTypeSchema.parse('flows_by_stage')).toThrow()
  })
})

describe('validateWidgetConfig', () => {
  it('applies per-type defaults when config is empty', () => {
    expect(validateWidgetConfig('issues_over_time', {})).toEqual({ days: 14 })
    expect(validateWidgetConfig('top_issues', {})).toEqual({ limit: 10, windowDays: 14 })
  })

  it('rejects an out-of-range value for its type', () => {
    expect(() => validateWidgetConfig('top_issues', { limit: 999 })).toThrow()
  })

  it('rejects config shaped for the wrong widget type', () => {
    expect(() => validateWidgetConfig('new_issues', { limit: 10 })).not.toThrow() // limit is just ignored, unknown keys stripped
    expect(validateWidgetConfig('new_issues', { limit: 10 })).toEqual({ windowDays: 14 })
  })
})

describe('WidgetLayoutSchema', () => {
  it('accepts a valid grid position within 12 columns', () => {
    expect(WidgetLayoutSchema.parse({ x: 0, y: 0, w: 6, h: 4 })).toEqual({ x: 0, y: 0, w: 6, h: 4 })
  })

  it('rejects a width wider than the 12-column grid', () => {
    expect(() => WidgetLayoutSchema.parse({ x: 0, y: 0, w: 13, h: 4 })).toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flare/shared-types test -- widgets`
Expected: FAIL — `Cannot find module './widgets'`

- [ ] **Step 3: Implement the widget-catalog schemas**

`packages/shared-types/src/widgets.ts`:
```ts
import { z } from 'zod'

export const WidgetTypeSchema = z.enum([
  'issues_over_time',
  'top_issues',
  'new_issues',
  'events_by_environment',
])
export type WidgetType = z.infer<typeof WidgetTypeSchema>

export const IssuesOverTimeConfigSchema = z.object({
  days: z.number().int().positive().max(90).default(14),
})
export const TopIssuesConfigSchema = z.object({
  limit: z.number().int().positive().max(50).default(10),
  windowDays: z.number().int().positive().max(90).default(14),
})
export const NewIssuesConfigSchema = z.object({
  windowDays: z.number().int().positive().max(90).default(14),
})
export const EventsByEnvironmentConfigSchema = z.object({
  windowDays: z.number().int().positive().max(90).default(14),
})

export const WidgetConfigSchemaByType = {
  issues_over_time: IssuesOverTimeConfigSchema,
  top_issues: TopIssuesConfigSchema,
  new_issues: NewIssuesConfigSchema,
  events_by_environment: EventsByEnvironmentConfigSchema,
} as const

export type WidgetConfigFor<T extends WidgetType> = z.infer<(typeof WidgetConfigSchemaByType)[T]>

export function validateWidgetConfig<T extends WidgetType>(type: T, config: unknown): WidgetConfigFor<T> {
  return WidgetConfigSchemaByType[type].parse(config) as WidgetConfigFor<T>
}

export const WidgetLayoutSchema = z.object({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  w: z.number().int().min(1).max(12),
  h: z.number().int().min(1).max(12),
})
export type WidgetLayout = z.infer<typeof WidgetLayoutSchema>

export const WidgetEnvironmentModeSchema = z.enum(['inherit', 'pin'])
export type WidgetEnvironmentMode = z.infer<typeof WidgetEnvironmentModeSchema>

export const WidgetSchema = z.object({
  id: z.string(),
  widgetType: WidgetTypeSchema,
  title: z.string(),
  layout: WidgetLayoutSchema,
  config: z.unknown(),
  environmentMode: WidgetEnvironmentModeSchema,
  pinnedEnvironmentName: z.string().nullable(),
})
export type Widget = z.infer<typeof WidgetSchema>

export const DashboardSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  envSelectorDefault: z.string().nullable(),
  widgets: z.array(WidgetSchema),
})
export type Dashboard = z.infer<typeof DashboardSchema>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @flare/shared-types test -- widgets`
Expected: PASS

- [ ] **Step 5: Barrel export, full suite, build, commit**

Add `export * from './widgets'` to `packages/shared-types/src/index.ts`.

Run: `pnpm --filter @flare/shared-types test && pnpm --filter @flare/shared-types build`
Expected: all pass, dual CJS/ESM build succeeds.

```bash
git add packages/shared-types
git commit -m "feat(shared-types): widget-catalog config schemas and Dashboard/Widget DTOs"
```

---

### Task 3: `provisionDefaultDashboard`

**Files:**
- Create: `packages/db/src/provision-dashboard.ts`
- Test: `packages/db/src/provision-dashboard.test.ts`
- Modify: `packages/db/src/index.ts`

**Interfaces:**
- Consumes: `Database` (Task 1).
- Produces: `provisionDefaultDashboard(db, projectId): Promise<string>`
  (returns the new `dashboard.id`) — creates the dashboard row plus the
  four starter-catalog widgets in a default 2-column layout. Consumed by
  Task 4 (project creation).

- [ ] **Step 1: Write the failing test**

`packages/db/src/provision-dashboard.test.ts`:
```ts
import { afterAll, describe, expect, it } from 'vitest'
import { createDb } from './create-db'
import { provisionDefaultDashboard } from './provision-dashboard'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')

afterAll(() => db.destroy())

describe('provisionDefaultDashboard', () => {
  it('creates a dashboard with the four starter widgets', async () => {
    const project = await db
      .insertInto('project')
      .values({ name: 'Provision Test', slug: `provision-test-${Date.now()}`, public_key: `pk-provision-${Date.now()}` })
      .returningAll()
      .executeTakeFirstOrThrow()

    const dashboardId = await provisionDefaultDashboard(db, project.id)

    const dashboard = await db.selectFrom('dashboard').selectAll().where('id', '=', dashboardId).executeTakeFirstOrThrow()
    expect(dashboard.project_id).toBe(project.id)

    const widgets = await db.selectFrom('dashboard_widget').selectAll().where('dashboard_id', '=', dashboardId).execute()
    expect(widgets.map((w) => w.widget_type).sort()).toEqual(
      ['events_by_environment', 'issues_over_time', 'new_issues', 'top_issues'].sort()
    )
  })

  it('is idempotent — calling it twice for the same project does not duplicate the dashboard', async () => {
    const project = await db
      .insertInto('project')
      .values({ name: 'Provision Idempotent', slug: `provision-idem-${Date.now()}`, public_key: `pk-provision-idem-${Date.now()}` })
      .returningAll()
      .executeTakeFirstOrThrow()

    const first = await provisionDefaultDashboard(db, project.id)
    const second = await provisionDefaultDashboard(db, project.id)

    expect(first).toBe(second)

    const dashboards = await db.selectFrom('dashboard').selectAll().where('project_id', '=', project.id).execute()
    expect(dashboards).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL=... pnpm --filter @flare/db test -- provision-dashboard`
Expected: FAIL — `Cannot find module './provision-dashboard'`

- [ ] **Step 3: Implement `provisionDefaultDashboard`**

`packages/db/src/provision-dashboard.ts`:
```ts
import type { Kysely } from 'kysely'
import type { Database } from './schema'

const STARTER_WIDGETS: Array<{ widget_type: string; title: string; layout: { x: number; y: number; w: number; h: number } }> = [
  { widget_type: 'issues_over_time', title: 'Issues Over Time', layout: { x: 0, y: 0, w: 6, h: 4 } },
  { widget_type: 'top_issues', title: 'Top Issues', layout: { x: 6, y: 0, w: 6, h: 4 } },
  { widget_type: 'new_issues', title: 'New Issues', layout: { x: 0, y: 4, w: 6, h: 4 } },
  { widget_type: 'events_by_environment', title: 'Events by Environment', layout: { x: 6, y: 4, w: 6, h: 4 } },
]

export async function provisionDefaultDashboard(db: Kysely<Database>, projectId: string): Promise<string> {
  return db.transaction().execute(async (trx) => {
    const existing = await trx
      .selectFrom('dashboard')
      .select('id')
      .where('project_id', '=', projectId)
      .executeTakeFirst()
    if (existing) return existing.id

    const dashboard = await trx
      .insertInto('dashboard')
      .values({ project_id: projectId })
      .returning('id')
      .executeTakeFirstOrThrow()

    await trx
      .insertInto('dashboard_widget')
      .values(
        STARTER_WIDGETS.map((widget) => ({
          dashboard_id: dashboard.id,
          widget_type: widget.widget_type,
          title: widget.title,
          layout: JSON.stringify(widget.layout),
          config: '{}',
        }))
      )
      .execute()

    return dashboard.id
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `DATABASE_URL=... pnpm --filter @flare/db test -- provision-dashboard`
Expected: PASS

- [ ] **Step 5: Barrel export and commit**

Add `export * from './provision-dashboard'` to `packages/db/src/index.ts`.

```bash
git add packages/db
git commit -m "feat(db): provisionDefaultDashboard with the starter widget catalog"
```

---

### Task 4: `POST /api/v1/projects` (Project Creation, Auto-Provisions Dashboard)

**Files:**
- Create: `apps/query-api/src/routes/projects.ts`
- Test: `apps/query-api/src/routes/projects.test.ts`
- Modify: `apps/query-api/src/app.ts`

**Interfaces:**
- Consumes: `provisionDefaultDashboard` (Task 3).
- Produces: `POST /api/v1/projects` (`{ name, slug }` → `{ id, name, slug,
  publicKey, dashboardId }`) — the first place in the whole system a
  project can be created without hand-writing SQL. Generates the DSN
  public key.

- [ ] **Step 1: Write the failing test**

`apps/query-api/src/routes/projects.test.ts`:
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

describe('POST /api/v1/projects', () => {
  it('creates a project with a generated public key and an auto-provisioned dashboard', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      payload: { name: 'New App', slug: `new-app-${Date.now()}` },
    })

    expect(response.statusCode).toBe(201)
    const body = response.json()
    expect(body.publicKey).toBeTruthy()

    const dashboard = await db
      .selectFrom('dashboard')
      .selectAll()
      .where('project_id', '=', body.id)
      .executeTakeFirstOrThrow()
    expect(dashboard.id).toBe(body.dashboardId)

    const widgets = await db.selectFrom('dashboard_widget').selectAll().where('dashboard_id', '=', dashboard.id).execute()
    expect(widgets).toHaveLength(4)
  })

  it('rejects a duplicate slug', async () => {
    const slug = `dup-${Date.now()}`
    await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: 'A', slug } })
    const response = await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: 'B', slug } })
    expect(response.statusCode).toBe(409)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL=... pnpm --filter @flare/query-api test -- projects`
Expected: FAIL — route not registered

- [ ] **Step 3: Implement the route**

`apps/query-api/src/routes/projects.ts`:
```ts
import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { provisionDefaultDashboard } from '@flare/db'

export function registerProjectRoutes(app: FastifyInstance): void {
  app.post<{ Body: { name: string; slug: string } }>('/api/v1/projects', async (request, reply) => {
    const { db } = app.deps
    const publicKey = randomBytes(16).toString('hex')

    let project
    try {
      project = await db
        .insertInto('project')
        .values({ name: request.body.name, slug: request.body.slug, public_key: publicKey })
        .returningAll()
        .executeTakeFirstOrThrow()
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        return reply.code(409).send({ error: 'slug or public key already exists' })
      }
      throw error
    }

    const dashboardId = await provisionDefaultDashboard(db, project.id)

    return reply.code(201).send({
      id: project.id,
      name: project.name,
      slug: project.slug,
      publicKey: project.public_key,
      dashboardId,
    })
  })
}
```

- [ ] **Step 4: Register the route in `app.ts`**

```ts
import { registerProjectRoutes } from './routes/projects'
// in buildApp, alongside registerIssueRoutes(app):
registerProjectRoutes(app)
```

- [ ] **Step 5: Run test to verify it passes**

Run: same command as Step 2.
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/query-api
git commit -m "feat(query-api): project creation, auto-provisioning the default dashboard"
```

---

### Task 5: Widget Query Functions

**Files:**
- Create: `apps/query-api/src/widgets/run-widget-query.ts`
- Test: `apps/query-api/src/widgets/run-widget-query.test.ts`

**Interfaces:**
- Consumes: `WidgetType`, `validateWidgetConfig` (Task 2).
- Produces: `runWidgetQuery(db, type, config, scope): Promise<unknown>`
  where `scope = { projectId: string; environmentName: string | null }` —
  the one dispatch point every widget-data request goes through (Task 8).
  No other function in this plan builds ad hoc SQL for widgets.

- [ ] **Step 1: Write the failing test**

`apps/query-api/src/widgets/run-widget-query.test.ts`:
```ts
import { createDb } from '@flare/db'
import { afterAll, describe, expect, it } from 'vitest'
import { runWidgetQuery } from './run-widget-query'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')

afterAll(() => db.destroy())

async function seedProjectWithData() {
  const project = await db
    .insertInto('project')
    .values({ name: 'Widget Query Test', slug: `widget-query-${Date.now()}`, public_key: `pk-widget-${Date.now()}` })
    .returningAll()
    .executeTakeFirstOrThrow()
  const environment = await db
    .insertInto('environment')
    .values({ project_id: project.id, name: 'production' })
    .returningAll()
    .executeTakeFirstOrThrow()
  const issue = await db
    .insertInto('issue')
    .values({ project_id: project.id, fingerprint: `fp-${Date.now()}`, title: 'TypeError: boom', grouping_raw_components: '{}' })
    .returningAll()
    .executeTakeFirstOrThrow()
  await db
    .insertInto('issue_environment')
    .values({ issue_id: issue.id, environment_id: environment.id, times_seen: 5 })
    .execute()
  await db
    .insertInto('event')
    .values({
      project_id: project.id,
      issue_id: issue.id,
      environment_id: environment.id,
      event_id: `evt-${Date.now()}`,
      timestamp: new Date(),
      exception: '{}',
    })
    .execute()
  return { project, environment, issue }
}

describe('runWidgetQuery', () => {
  it('issues_over_time returns a daily count series', async () => {
    const { project } = await seedProjectWithData()
    const result = await runWidgetQuery(db, 'issues_over_time', { days: 14 }, { projectId: project.id, environmentName: null })
    expect(Array.isArray(result)).toBe(true)
    expect((result as Array<{ count: number }>).reduce((sum, row) => sum + Number(row.count), 0)).toBeGreaterThan(0)
  })

  it('top_issues returns issues ordered by times_seen, filtered by environment', async () => {
    const { project, environment, issue } = await seedProjectWithData()
    const result = (await runWidgetQuery(
      db,
      'top_issues',
      { limit: 10, windowDays: 14 },
      { projectId: project.id, environmentName: environment.name }
    )) as Array<{ id: string }>
    expect(result.some((row) => row.id === issue.id)).toBe(true)
  })

  it('new_issues returns recently first-seen issues', async () => {
    const { project, issue } = await seedProjectWithData()
    const result = (await runWidgetQuery(
      db,
      'new_issues',
      { windowDays: 14 },
      { projectId: project.id, environmentName: null }
    )) as Array<{ id: string }>
    expect(result.some((row) => row.id === issue.id)).toBe(true)
  })

  it('events_by_environment returns a count per environment name', async () => {
    const { project, environment } = await seedProjectWithData()
    const result = (await runWidgetQuery(
      db,
      'events_by_environment',
      { windowDays: 14 },
      { projectId: project.id, environmentName: null }
    )) as Array<{ environmentName: string; count: number }>
    const row = result.find((r) => r.environmentName === environment.name)
    expect(row?.count).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL=... pnpm --filter @flare/query-api test -- run-widget-query`
Expected: FAIL — `Cannot find module './run-widget-query'`

- [ ] **Step 3: Implement `runWidgetQuery`**

`apps/query-api/src/widgets/run-widget-query.ts`:
```ts
import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { Database } from '@flare/db'
import {
  validateWidgetConfig,
  type WidgetType,
  type WidgetConfigFor,
} from '@flare/shared-types'

export interface WidgetScope {
  projectId: string
  environmentName: string | null
}

async function issuesOverTime(db: Kysely<Database>, config: WidgetConfigFor<'issues_over_time'>, scope: WidgetScope) {
  let query = db
    .selectFrom('event')
    .select([sql<string>`date_trunc('day', "timestamp")`.as('day'), sql<number>`count(*)`.as('count')])
    .where('project_id', '=', scope.projectId)
    .where('timestamp', '>=', sql<Date>`now() - (${config.days} || ' days')::interval`)
    .groupBy(sql`date_trunc('day', "timestamp")`)
    .orderBy('day', 'asc')

  if (scope.environmentName) {
    query = query
      .innerJoin('environment', 'environment.id', 'event.environment_id')
      .where('environment.name', '=', scope.environmentName)
  }

  return query.execute()
}

async function topIssues(db: Kysely<Database>, config: WidgetConfigFor<'top_issues'>, scope: WidgetScope) {
  let query = db
    .selectFrom('issue')
    .innerJoin('issue_environment', 'issue_environment.issue_id', 'issue.id')
    .selectAll('issue')
    .select('issue_environment.times_seen as env_times_seen')
    .where('issue.project_id', '=', scope.projectId)
    .where('issue_environment.last_seen', '>=', sql<Date>`now() - (${config.windowDays} || ' days')::interval`)
    .orderBy('issue_environment.times_seen', 'desc')
    .limit(config.limit)

  if (scope.environmentName) {
    query = query
      .innerJoin('environment', 'environment.id', 'issue_environment.environment_id')
      .where('environment.name', '=', scope.environmentName)
  }

  return query.execute()
}

async function newIssues(db: Kysely<Database>, config: WidgetConfigFor<'new_issues'>, scope: WidgetScope) {
  let query = db
    .selectFrom('issue')
    .selectAll()
    .where('project_id', '=', scope.projectId)
    .where('first_seen', '>=', sql<Date>`now() - (${config.windowDays} || ' days')::interval`)
    .orderBy('first_seen', 'desc')

  if (scope.environmentName) {
    query = query
      .innerJoin('issue_environment', 'issue_environment.issue_id', 'issue.id')
      .innerJoin('environment', 'environment.id', 'issue_environment.environment_id')
      .where('environment.name', '=', scope.environmentName)
  }

  return query.execute()
}

async function eventsByEnvironment(db: Kysely<Database>, config: WidgetConfigFor<'events_by_environment'>, scope: WidgetScope) {
  return db
    .selectFrom('event')
    .innerJoin('environment', 'environment.id', 'event.environment_id')
    .select(['environment.name as environmentName', sql<number>`count(*)`.as('count')])
    .where('event.project_id', '=', scope.projectId)
    .where('event.timestamp', '>=', sql<Date>`now() - (${config.windowDays} || ' days')::interval`)
    .groupBy('environment.name')
    .execute()
}

export async function runWidgetQuery(
  db: Kysely<Database>,
  type: WidgetType,
  rawConfig: unknown,
  scope: WidgetScope
): Promise<unknown> {
  switch (type) {
    case 'issues_over_time':
      return issuesOverTime(db, validateWidgetConfig('issues_over_time', rawConfig), scope)
    case 'top_issues':
      return topIssues(db, validateWidgetConfig('top_issues', rawConfig), scope)
    case 'new_issues':
      return newIssues(db, validateWidgetConfig('new_issues', rawConfig), scope)
    case 'events_by_environment':
      return eventsByEnvironment(db, validateWidgetConfig('events_by_environment', rawConfig), scope)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: same command as Step 2.
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/query-api
git commit -m "feat(query-api): vetted widget query functions, one per catalog type"
```

---

### Task 6: `GET /api/v1/projects/:projectId/dashboard`

**Files:**
- Create: `apps/query-api/src/routes/dashboard.ts`
- Test: `apps/query-api/src/routes/dashboard.test.ts`
- Modify: `apps/query-api/src/app.ts`

**Interfaces:**
- Consumes: `DashboardSchema`/`WidgetSchema` (Task 2).
- Produces: `GET /api/v1/projects/:projectId/dashboard` → `Dashboard`
  (camelCase DTO) — consumed by `web` (Task 9).

- [ ] **Step 1: Write the failing test**

`apps/query-api/src/routes/dashboard.test.ts`:
```ts
import { createDb, provisionDefaultDashboard } from '@flare/db'
import { afterAll, describe, expect, it } from 'vitest'
import { buildApp } from '../app'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')
const app = buildApp({ db })

afterAll(async () => {
  await db.destroy()
  await app.close()
})

describe('GET /api/v1/projects/:projectId/dashboard', () => {
  it('returns the provisioned dashboard with its four widgets', async () => {
    const project = await db
      .insertInto('project')
      .values({ name: 'Dashboard Fetch Test', slug: `dash-fetch-${Date.now()}`, public_key: `pk-dash-${Date.now()}` })
      .returningAll()
      .executeTakeFirstOrThrow()
    await provisionDefaultDashboard(db, project.id)

    const response = await app.inject({ method: 'GET', url: `/api/v1/projects/${project.id}/dashboard` })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.projectId).toBe(project.id)
    expect(body.widgets).toHaveLength(4)
  })

  it('returns 404 when the project has no dashboard', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/00000000-0000-0000-0000-000000000000/dashboard',
    })
    expect(response.statusCode).toBe(404)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL=... pnpm --filter @flare/query-api test -- dashboard`
Expected: FAIL — route not registered

- [ ] **Step 3: Implement the route**

`apps/query-api/src/routes/dashboard.ts`:
```ts
import type { FastifyInstance } from 'fastify'
import type { Dashboard } from '@flare/shared-types'

export function registerDashboardRoutes(app: FastifyInstance): void {
  app.get<{ Params: { projectId: string } }>(
    '/api/v1/projects/:projectId/dashboard',
    async (request, reply) => {
      const dashboard = await app.deps.db
        .selectFrom('dashboard')
        .selectAll()
        .where('project_id', '=', request.params.projectId)
        .executeTakeFirst()

      if (!dashboard) return reply.code(404).send({ error: 'not found' })

      const widgets = await app.deps.db
        .selectFrom('dashboard_widget')
        .selectAll()
        .where('dashboard_id', '=', dashboard.id)
        .execute()

      const body: Dashboard = {
        id: dashboard.id,
        projectId: dashboard.project_id,
        name: dashboard.name,
        envSelectorDefault: dashboard.env_selector_default,
        widgets: widgets.map((widget) => ({
          id: widget.id,
          widgetType: widget.widget_type as Dashboard['widgets'][number]['widgetType'],
          title: widget.title,
          layout: widget.layout as Dashboard['widgets'][number]['layout'],
          config: widget.config,
          environmentMode: widget.environment_mode,
          pinnedEnvironmentName: widget.pinned_environment_name,
        })),
      }
      return body
    }
  )
}
```

- [ ] **Step 4: Register in `app.ts` and run test to verify it passes**

```ts
import { registerDashboardRoutes } from './routes/dashboard'
// alongside the other register*Routes(app) calls:
registerDashboardRoutes(app)
```

Run: same command as Step 2.
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/query-api
git commit -m "feat(query-api): GET dashboard endpoint returning widgets as camelCase DTOs"
```

---

### Task 7: Widget CRUD (Add / Remove / Layout / Config)

**Files:**
- Create: `apps/query-api/src/routes/widgets.ts`
- Test: `apps/query-api/src/routes/widgets.test.ts`
- Modify: `apps/query-api/src/app.ts`

**Interfaces:**
- Consumes: `WidgetTypeSchema`, `WidgetLayoutSchema`, `validateWidgetConfig`
  (Task 2).
- Produces: `POST /api/v1/widgets`, `DELETE /api/v1/widgets/:id`,
  `PATCH /api/v1/widgets/:id/layout`, `PATCH /api/v1/widgets/:id/config`.

- [ ] **Step 1: Write the failing test**

`apps/query-api/src/routes/widgets.test.ts`:
```ts
import { createDb, provisionDefaultDashboard } from '@flare/db'
import { afterAll, describe, expect, it } from 'vitest'
import { buildApp } from '../app'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')
const app = buildApp({ db })

afterAll(async () => {
  await db.destroy()
  await app.close()
})

async function seedDashboard() {
  const project = await db
    .insertInto('project')
    .values({ name: 'Widget CRUD Test', slug: `widget-crud-${Date.now()}`, public_key: `pk-crud-${Date.now()}` })
    .returningAll()
    .executeTakeFirstOrThrow()
  const dashboardId = await provisionDefaultDashboard(db, project.id)
  return { project, dashboardId }
}

describe('widget CRUD', () => {
  it('adds a widget, updates its layout and config independently, then removes it', async () => {
    const { dashboardId } = await seedDashboard()

    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/widgets',
      payload: { dashboardId, widgetType: 'new_issues', title: 'Custom New Issues', layout: { x: 0, y: 8, w: 4, h: 3 } },
    })
    expect(createResponse.statusCode).toBe(201)
    const widgetId = createResponse.json().id

    const layoutResponse = await app.inject({
      method: 'PATCH',
      url: `/api/v1/widgets/${widgetId}/layout`,
      payload: { x: 2, y: 10, w: 5, h: 3 },
    })
    expect(layoutResponse.statusCode).toBe(200)

    const configResponse = await app.inject({
      method: 'PATCH',
      url: `/api/v1/widgets/${widgetId}/config`,
      payload: { windowDays: 30 },
    })
    expect(configResponse.statusCode).toBe(200)

    const stored = await db.selectFrom('dashboard_widget').selectAll().where('id', '=', widgetId).executeTakeFirstOrThrow()
    expect(stored.layout).toEqual({ x: 2, y: 10, w: 5, h: 3 })
    expect(stored.config).toEqual({ windowDays: 30 })

    const deleteResponse = await app.inject({ method: 'DELETE', url: `/api/v1/widgets/${widgetId}` })
    expect(deleteResponse.statusCode).toBe(204)

    const gone = await db.selectFrom('dashboard_widget').selectAll().where('id', '=', widgetId).executeTakeFirst()
    expect(gone).toBeUndefined()
  })

  it('rejects a config PATCH that fails the widget type\'s own validation', async () => {
    const { dashboardId } = await seedDashboard()
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/widgets',
      payload: { dashboardId, widgetType: 'top_issues', title: 'Bad Config Test', layout: { x: 0, y: 0, w: 4, h: 3 } },
    })
    const widgetId = created.json().id

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/widgets/${widgetId}/config`,
      payload: { limit: 9999 },
    })
    expect(response.statusCode).toBe(400)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL=... pnpm --filter @flare/query-api test -- widgets`
Expected: FAIL — routes not registered

- [ ] **Step 3: Implement the routes**

`apps/query-api/src/routes/widgets.ts`:
```ts
import type { FastifyInstance } from 'fastify'
import { WidgetLayoutSchema, WidgetTypeSchema, validateWidgetConfig } from '@flare/shared-types'

export function registerWidgetRoutes(app: FastifyInstance): void {
  app.post<{ Body: { dashboardId: string; widgetType: string; title: string; layout: unknown } }>(
    '/api/v1/widgets',
    async (request, reply) => {
      const widgetType = WidgetTypeSchema.parse(request.body.widgetType)
      const layout = WidgetLayoutSchema.parse(request.body.layout)

      const widget = await app.deps.db
        .insertInto('dashboard_widget')
        .values({
          dashboard_id: request.body.dashboardId,
          widget_type: widgetType,
          title: request.body.title,
          layout: JSON.stringify(layout),
          config: '{}',
        })
        .returning('id')
        .executeTakeFirstOrThrow()

      return reply.code(201).send({ id: widget.id })
    }
  )

  app.delete<{ Params: { id: string } }>('/api/v1/widgets/:id', async (request, reply) => {
    await app.deps.db.deleteFrom('dashboard_widget').where('id', '=', request.params.id).execute()
    return reply.code(204).send()
  })

  app.patch<{ Params: { id: string }; Body: unknown }>('/api/v1/widgets/:id/layout', async (request, reply) => {
    const layout = WidgetLayoutSchema.parse(request.body)
    await app.deps.db
      .updateTable('dashboard_widget')
      .set({ layout: JSON.stringify(layout), layout_updated_at: new Date() })
      .where('id', '=', request.params.id)
      .execute()
    return reply.code(200).send({ ok: true })
  })

  app.patch<{ Params: { id: string }; Body: unknown }>('/api/v1/widgets/:id/config', async (request, reply) => {
    const widget = await app.deps.db
      .selectFrom('dashboard_widget')
      .select('widget_type')
      .where('id', '=', request.params.id)
      .executeTakeFirst()
    if (!widget) return reply.code(404).send({ error: 'not found' })

    let config: unknown
    try {
      config = validateWidgetConfig(WidgetTypeSchema.parse(widget.widget_type), request.body)
    } catch {
      return reply.code(400).send({ error: 'invalid config for this widget type' })
    }

    await app.deps.db
      .updateTable('dashboard_widget')
      .set({ config: JSON.stringify(config), config_updated_at: new Date() })
      .where('id', '=', request.params.id)
      .execute()
    return reply.code(200).send({ ok: true })
  })
}
```

- [ ] **Step 4: Register in `app.ts` and run test to verify it passes**

```ts
import { registerWidgetRoutes } from './routes/widgets'
// alongside the other register*Routes(app) calls:
registerWidgetRoutes(app)
```

Run: same command as Step 2.
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/query-api
git commit -m "feat(query-api): widget add/remove and independent layout/config PATCH"
```

---

### Task 8: `GET /api/v1/widgets/:id/data` (Generic, Redis-Cached)

**Files:**
- Create: `apps/query-api/src/routes/widget-data.ts`
- Test: `apps/query-api/src/routes/widget-data.test.ts`
- Modify: `apps/query-api/src/app.ts`
- Modify: `apps/query-api/package.json`

**Interfaces:**
- Consumes: `runWidgetQuery` (Task 5).
- Produces: `GET /api/v1/widgets/:id/data?environment=<name|omitted>` — every
  widget fetches its own data independently; response optionally served
  from a 30s Redis cache keyed by `(widgetType, configHash,
  resolvedEnvironmentName)`, exactly as the architecture plan specifies.
  `AppDeps` gains `redis`.

- [ ] **Step 1: Add `ioredis` to `query-api`**

Add to `apps/query-api/package.json` dependencies: `"ioredis": "^5.4.0"`.
Add `redis: Redis` to `AppDeps` in `apps/query-api/src/app.ts`.

- [ ] **Step 2: Write the failing test**

`apps/query-api/src/routes/widget-data.test.ts`:
```ts
import { createDb, provisionDefaultDashboard } from '@flare/db'
import Redis from 'ioredis'
import { afterAll, describe, expect, it } from 'vitest'
import { buildApp } from '../app'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379')
const app = buildApp({ db, redis })

afterAll(async () => {
  await db.destroy()
  redis.disconnect()
  await app.close()
})

describe('GET /api/v1/widgets/:id/data', () => {
  it('returns data for a provisioned widget and caches the response', async () => {
    const project = await db
      .insertInto('project')
      .values({ name: 'Widget Data Test', slug: `widget-data-${Date.now()}`, public_key: `pk-widget-data-${Date.now()}` })
      .returningAll()
      .executeTakeFirstOrThrow()
    const dashboardId = await provisionDefaultDashboard(db, project.id)
    const widget = await db
      .selectFrom('dashboard_widget')
      .selectAll()
      .where('dashboard_id', '=', dashboardId)
      .where('widget_type', '=', 'new_issues')
      .executeTakeFirstOrThrow()

    const response = await app.inject({ method: 'GET', url: `/api/v1/widgets/${widget.id}/data` })

    expect(response.statusCode).toBe(200)
    expect(Array.isArray(response.json().data)).toBe(true)

    const cacheKeys = await redis.keys('widgetdata:*')
    expect(cacheKeys.length).toBeGreaterThan(0)
  })

  it('returns 404 for an unknown widget', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/widgets/00000000-0000-0000-0000-000000000000/data',
    })
    expect(response.statusCode).toBe(404)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `DATABASE_URL=... REDIS_URL=... pnpm --filter @flare/query-api test -- widget-data`
Expected: FAIL — route not registered

- [ ] **Step 4: Implement the route**

`apps/query-api/src/routes/widget-data.ts`:
```ts
import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { WidgetTypeSchema } from '@flare/shared-types'
import { runWidgetQuery } from '../widgets/run-widget-query'

const CACHE_TTL_SECONDS = 30

export function registerWidgetDataRoute(app: FastifyInstance): void {
  app.get<{ Params: { id: string }; Querystring: { environment?: string } }>(
    '/api/v1/widgets/:id/data',
    async (request, reply) => {
      const { db, redis } = app.deps
      const widget = await db
        .selectFrom('dashboard_widget')
        .innerJoin('dashboard', 'dashboard.id', 'dashboard_widget.dashboard_id')
        .select(['dashboard_widget.widget_type', 'dashboard_widget.config', 'dashboard_widget.environment_mode', 'dashboard_widget.pinned_environment_name', 'dashboard.project_id', 'dashboard.env_selector_default'])
        .where('dashboard_widget.id', '=', request.params.id)
        .executeTakeFirst()

      if (!widget) return reply.code(404).send({ error: 'not found' })

      const environmentName =
        widget.environment_mode === 'pin' ? widget.pinned_environment_name : request.query.environment ?? widget.env_selector_default ?? null

      const configHash = createHash('sha1').update(JSON.stringify(widget.config)).digest('hex')
      const cacheKey = `widgetdata:${widget.widget_type}:${configHash}:${environmentName ?? 'all'}`

      const cached = await redis.get(cacheKey)
      if (cached) return reply.send({ data: JSON.parse(cached) })

      const data = await runWidgetQuery(db, WidgetTypeSchema.parse(widget.widget_type), widget.config, {
        projectId: widget.project_id,
        environmentName,
      })

      await redis.set(cacheKey, JSON.stringify(data), 'EX', CACHE_TTL_SECONDS)
      return reply.send({ data })
    }
  )
}
```

- [ ] **Step 5: Register the route, wire `redis` into `server.ts`, run test to verify it passes**

```ts
import { registerWidgetDataRoute } from './routes/widget-data'
// alongside the other register*Routes(app) calls:
registerWidgetDataRoute(app)
```

`apps/query-api/src/server.ts` gains a `Redis` instance passed into
`buildApp`, same pattern as `ingest-api`'s `server.ts`.

Run: same command as Step 3.
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/query-api
git commit -m "feat(query-api): generic redis-cached widget-data endpoint"
```

---

### Task 9: Web Dashboard Page (`react-grid-layout` + `recharts`)

**Files:**
- Create: `apps/web/src/pages/DashboardPage.tsx`
- Test: `apps/web/src/pages/DashboardPage.test.tsx`
- Create: `apps/web/src/widgets/WidgetChart.tsx`
- Modify: `apps/web/src/api/query-client.ts`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/package.json`

**Interfaces:**
- Consumes: `Dashboard`, `Widget` DTOs (Task 2), the dashboard/widget-data
  endpoints (Tasks 6/8).
- Produces: `fetchDashboard(projectId): Promise<Dashboard>`,
  `fetchWidgetData(widgetId, environment?): Promise<unknown>` in
  `query-client.ts`; `<DashboardPage projectId={...} />` route.

- [ ] **Step 1: Add dependencies**

Add to `apps/web/package.json` dependencies: `"react-grid-layout":
"^1.5.0"`, `"recharts": "^2.12.0"`. Add
`"@types/react-grid-layout": "^1.3.0"` to devDependencies.

- [ ] **Step 2: Write the failing test**

`apps/web/src/pages/DashboardPage.test.tsx`:
```tsx
import { render, screen, waitFor } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { DashboardPage } from './DashboardPage'

const server = setupServer(
  http.get('http://localhost:3001/api/v1/projects/proj-1/dashboard', () =>
    HttpResponse.json({
      id: 'dash-1',
      projectId: 'proj-1',
      name: 'Default',
      envSelectorDefault: null,
      widgets: [
        {
          id: 'widget-1',
          widgetType: 'new_issues',
          title: 'New Issues',
          layout: { x: 0, y: 0, w: 6, h: 4 },
          config: { windowDays: 14 },
          environmentMode: 'inherit',
          pinnedEnvironmentName: null,
        },
      ],
    })
  ),
  http.get('http://localhost:3001/api/v1/widgets/widget-1/data', () =>
    HttpResponse.json({ data: [{ id: 'issue-1', title: 'TypeError: boom' }] })
  )
)

beforeAll(() => server.listen())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('DashboardPage', () => {
  it('renders each widget by title once its data has loaded', async () => {
    render(<DashboardPage projectId="proj-1" />)

    await waitFor(() => expect(screen.getByText('New Issues')).toBeInTheDocument())
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @flare/web test -- DashboardPage`
Expected: FAIL — `Cannot find module './DashboardPage'`

- [ ] **Step 4: Extend the API client**

Add to `apps/web/src/api/query-client.ts`:
```ts
import { DashboardSchema, type Dashboard } from '@flare/shared-types'

export async function fetchDashboard(projectId: string): Promise<Dashboard> {
  const response = await fetch(`${QUERY_API_BASE_URL}/api/v1/projects/${projectId}/dashboard`)
  return DashboardSchema.parse(await response.json())
}

export async function fetchWidgetData(widgetId: string, environment?: string): Promise<unknown> {
  const query = environment ? `?environment=${encodeURIComponent(environment)}` : ''
  const response = await fetch(`${QUERY_API_BASE_URL}/api/v1/widgets/${widgetId}/data${query}`)
  const body = await response.json()
  return body.data
}
```
(add `DashboardSchema` to the existing import line's named imports from
`@flare/shared-types`, not a second import statement)

- [ ] **Step 5: Implement a minimal widget data renderer**

`apps/web/src/widgets/WidgetChart.tsx` (a placeholder-shape renderer for
this phase — the four starter types return heterogeneous row shapes, and
per-type chart components are a natural follow-up, not required for the
MVP's "widgets fetch and render independently" goal):
```tsx
export function WidgetChart({ data }: { data: unknown }) {
  if (!Array.isArray(data)) return <p>No data</p>
  if (data.length === 0) return <p>No data in this window</p>
  return (
    <ul>
      {data.map((row, i) => (
        <li key={i}>{JSON.stringify(row)}</li>
      ))}
    </ul>
  )
}
```

- [ ] **Step 6: Implement `DashboardPage`**

`apps/web/src/pages/DashboardPage.tsx`:
```tsx
import { useEffect, useState } from 'react'
import GridLayout from 'react-grid-layout'
import type { Dashboard } from '@flare/shared-types'
import { fetchDashboard, fetchWidgetData } from '../api/query-client'
import { WidgetChart } from '../widgets/WidgetChart'

export function DashboardPage({ projectId }: { projectId: string }) {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null)
  const [dataByWidget, setDataByWidget] = useState<Record<string, unknown>>({})

  useEffect(() => {
    fetchDashboard(projectId).then((result) => {
      setDashboard(result)
      for (const widget of result.widgets) {
        fetchWidgetData(widget.id).then((data) => {
          setDataByWidget((prev) => ({ ...prev, [widget.id]: data }))
        })
      }
    })
  }, [projectId])

  if (!dashboard) return <p>Loading…</p>

  const layout = dashboard.widgets.map((widget) => ({ i: widget.id, ...widget.layout }))

  return (
    <GridLayout layout={layout} cols={12} rowHeight={60} width={1200}>
      {dashboard.widgets.map((widget) => (
        <div key={widget.id}>
          <h3>{widget.title}</h3>
          <WidgetChart data={dataByWidget[widget.id]} />
        </div>
      ))}
    </GridLayout>
  )
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm --filter @flare/web test -- DashboardPage`
Expected: PASS

- [ ] **Step 8: Wire a route and run the full suite/build**

Add a `/projects/:projectId/dashboard` route to `apps/web/src/App.tsx`
rendering `<DashboardPage projectId={...} />` (read `projectId` from
`useParams`, same pattern as `IssueDetailPage`).

Run: `pnpm --filter @flare/web test && pnpm --filter @flare/web typecheck
&& pnpm --filter @flare/web build`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add apps/web
git commit -m "feat(web): dashboard page with react-grid-layout, widgets fetch independently"
```

---

## Verification (after all 9 tasks)

1. `pnpm turbo run lint typecheck build --force` from a clean state —
   fully verifiable in this sandbox.
2. On a Docker-enabled machine: `docker compose up -d`, run migrations,
   `pnpm turbo run test` — every DB/Redis-backed test in this plan should
   go green.
3. Manually: `POST /api/v1/projects`, confirm the response's
   `dashboardId` matches a real row, open
   `/projects/<id>/dashboard` in the web UI, confirm all four starter
   widgets render (empty is fine with no events yet), send a couple of
   error events through the Phase 1 pipeline for that project, refresh,
   and confirm `new_issues`/`top_issues` reflect them within the 30s
   cache window.
