# Flare — Business-Flow Tracing MVP (implementation plan)

This corresponds to **Phase 5** in the original architecture plan's roadmap
(`flare-technical-plan.md`, §11), not to the file named
`2026-09-18-flare-phase5-remove-kafka-bullmq.md` — that filename was already
taken by the Kafka-removal infra work, which was chronologically slotted in
ahead of this feature phase. This doc is therefore the 6th executed
implementation-plan phase in this repo, covering the 5th feature phase from
the original roadmap.

## Scope decision (read before executing)

The original plan's Phase 5 bullet is:

> `flow_definition`/`flow_step_definition`/`flow_trace`/`flow_step`/
> `flow_alias` tables, native checkpoint API, `flow-stitch-worker`, published
> OpenAPI spec, first instrumentation targets (Exchange service as the
> chokepoint + one or two own apps + Dynamics webhook seeding), basic
> swimlane UI, `flows_by_stage` widget. Gated on the identity-stitching
> matrix (§10a) being validated with system owners first.

Three parts of that are **not buildable autonomously** and are explicitly
excluded here:

- **"First instrumentation targets"** (wiring the real Exchange service,
  Dynamics webhooks, AMS2/ClientHub/AMS Surveying): this requires access to
  those actual systems and sign-off from their owners. Nothing to build in
  this repo — it's an integration task for those teams once Flare's generic
  checkpoint API exists.
- **The identity-stitching matrix validation** (§10a): a business-analysis
  deliverable requiring real system owners, not something derivable from
  code. The generic alias-stitching *mechanism* is system-agnostic (it
  works on whatever `(system, entityId)` pairs any caller reports) and does
  not depend on knowing SOCOTEC's real ID formats, so it's still built here
  — only the specific mapping matrix is deferred.
- **`flow_definition`/`flow_step_definition`**: these exist to support
  stall detection and deviation detection, both explicitly Phase 6 work
  ("Flow tracing maturity"). `flow_trace` has no hard dependency on a
  `flow_definition_id` (flows can exist ad hoc), so this MVP skips both
  tables entirely and adds them in Phase 6 when stall-detection actually
  needs them. Flagged here as a deliberate deviation, not an oversight.
- **OpenAPI spec** (§5c): cross-cutting across the whole API surface, not
  specific to this feature. Deferred to a dedicated task, not bundled here.

What **is** built: `flow_trace`, `flow_step`, `flow_alias` tables; the
native `POST /api/v1/flows/checkpoints` API; a new `flow-stitch-worker` app
consuming the checkpoint queue and doing the alias-stitching from §10a;
`GET /api/v1/flows/:flowTraceId` (swimlane data); the `flows_by_stage`
widget type; a basic `FlowDetailPage` in the web UI.

## Global constraints

- Checkpoints are ingested via BullMQ (`ingest.flow` queue), matching every
  other ingest path since the Kafka removal — no reintroducing a
  Kafka-specific "low partition count" concept; that was a Kafka ordering
  trick and has no BullMQ equivalent (nor is one needed, since correctness
  here comes from DB constraints per §10b, not partition ordering).
- Idempotency: `flow_step.dedup_key` is `UNIQUE`; a retried checkpoint is a
  silent no-op via `ON CONFLICT (dedup_key) DO NOTHING`.
- Out-of-order arrival: `flow_trace.current_stage`/`last_activity_at` only
  advance when the incoming checkpoint's `occurred_at` is `>=` the trace's
  current `last_activity_at` — a late-arriving-but-earlier-timestamped
  checkpoint must not regress the visible current stage.
- Concurrent identity creation race: two checkpoints reporting the same
  brand-new `(system, entityId)` pair at the same time must not create two
  separate `flow_trace` rows. Resolved via `INSERT ... ON CONFLICT
  (system, entity_id) DO NOTHING` on `flow_alias` — the loser adopts the
  winner's `flow_trace_id` instead of leaving its own freshly-created trace
  orphaned. Distinct from a genuine identity conflict (two *different*,
  already-established aliases in the same checkpoint pointing at two
  different existing traces) — that case is only logged via `console.warn`
  for manual review, never auto-merged, matching the original plan's own
  risk note about needing a human escape hatch for bad stitches.
- No auth scheme invented: reuses the exact `Bearer <dsn_public_key>` +
  `resolveProjectByPublicKey` pattern already used by
  `apps/ingest-api/src/routes/releases.ts`, per §5b's own assumption ("the
  same project DSN public key... via a simple bearer/header scheme").
- `flow_trace` has no `environment_id` (matches §2's schema — flows cross
  whole systems, not Sentry-style environments), so the `flows_by_stage`
  widget ignores the dashboard's environment selector entirely; this is a
  deliberate scope difference from every other widget type, not a bug.

## Task 1: DB schema — `flow_trace`, `flow_step`, `flow_alias`

**Files:**
- Create: `packages/db/migrations/1700000000017_create-flow-trace.cjs`
- Create: `packages/db/migrations/1700000000018_create-flow-step.cjs`
- Create: `packages/db/migrations/1700000000019_create-flow-alias.cjs`
- Modify: `packages/db/src/schema.ts` (add `FlowTraceTable`,
  `FlowStepTable`, `FlowAliasTable`, add to `Database`)
- Create: `packages/db/src/attach-or-create-flow-trace.ts` +
  `.test.ts`
- Create: `packages/db/src/upsert-flow-step.ts` + `.test.ts`
- Modify: `packages/db/src/index.ts` (export both new modules)

**Schema** (mirrors §2, minus `flow_definition_id`/`tech_trace_id` FK
enforcement — both are soft references per the original plan, kept as
plain nullable text/uuid columns with no FK constraint since traces/issues
may live past a target's retention window):

```
flow_trace: id uuid pk, project_id uuid fk->project cascade,
  status text default 'in_progress' + CHECK IN ('in_progress','completed','stalled','abandoned'),
  current_stage text null, started_at timestamptz default now(),
  last_activity_at timestamptz default now(), completed_at timestamptz null

flow_step: id uuid pk, flow_trace_id uuid fk->flow_trace cascade,
  stage_name text not null, system text not null,
  dedup_key text not null UNIQUE, reported_ids jsonb not null default '[]',
  tech_trace_id text null, issue_id uuid null (no FK), occurred_at timestamptz not null,
  received_at timestamptz default now(), status text default 'ok' + CHECK IN ('ok','error')
  index (flow_trace_id, occurred_at)

flow_alias: id uuid pk, flow_trace_id uuid fk->flow_trace cascade,
  system text not null, entity_id text not null,
  first_seen timestamptz default now(), last_seen timestamptz default now(),
  UNIQUE(system, entity_id)
```

**`attachOrCreateFlowTrace`** (implements §10a's stitching algorithm plus
the concurrency-race handling from Global Constraints above):

```ts
export async function attachOrCreateFlowTrace(
  db: Kysely<Database>,
  params: { projectId: string; reportedIds: { system: string; entityId: string }[] }
): Promise<string> {
  let flowTraceId: string | null = null
  for (const { system, entityId } of params.reportedIds) {
    const alias = await db
      .selectFrom('flow_alias')
      .select('flow_trace_id')
      .where('system', '=', system)
      .where('entity_id', '=', entityId)
      .executeTakeFirst()
    if (alias) {
      flowTraceId = alias.flow_trace_id
      break
    }
  }

  let createdNewTrace = false
  if (!flowTraceId) {
    const trace = await db
      .insertInto('flow_trace')
      .values({ project_id: params.projectId })
      .returning('id')
      .executeTakeFirstOrThrow()
    flowTraceId = trace.id
    createdNewTrace = true
  }

  for (const { system, entityId } of params.reportedIds) {
    const inserted = await db
      .insertInto('flow_alias')
      .values({ flow_trace_id: flowTraceId, system, entity_id: entityId })
      .onConflict((oc) => oc.columns(['system', 'entity_id']).doNothing())
      .returning('flow_trace_id')
      .executeTakeFirst()

    if (!inserted) {
      const existing = await db
        .selectFrom('flow_alias')
        .select('flow_trace_id')
        .where('system', '=', system)
        .where('entity_id', '=', entityId)
        .executeTakeFirstOrThrow()
      if (existing.flow_trace_id !== flowTraceId) {
        if (createdNewTrace) {
          flowTraceId = existing.flow_trace_id
          createdNewTrace = false
        } else {
          console.warn(
            `flow-stitch: identity conflict -- (${system}, ${entityId}) already aliased to ` +
              `flow_trace ${existing.flow_trace_id}, this checkpoint resolved to ${flowTraceId}. ` +
              `Not merging automatically; needs manual review.`
          )
        }
      }
    }
  }

  return flowTraceId
}
```

Test cases: (a) first-ever checkpoint for a new entity creates a trace and
registers its alias; (b) a later checkpoint reporting an already-known id
plus a newly-seen id attaches to the existing trace and registers the new
alias; (c) two concurrent calls (`Promise.all`) reporting the exact same
brand-new id both resolve to the *same* single `flow_trace_id` (proves the
race fix); (d) two calls reporting disjoint, independently-already-aliased
ids resolve without throwing and a `console.warn` spy fires (proves the
conflict path doesn't silently merge).

**`upsertFlowStep`** (idempotent insert + monotonic current-stage advance):

```ts
export async function upsertFlowStep(
  db: Kysely<Database>,
  params: {
    flowTraceId: string
    stageName: string
    system: string
    dedupKey: string
    reportedIds: unknown
    techTraceId: string | null
    issueId: string | null
    occurredAt: Date
    status: 'ok' | 'error'
  }
): Promise<void> {
  const inserted = await db
    .insertInto('flow_step')
    .values({
      flow_trace_id: params.flowTraceId,
      stage_name: params.stageName,
      system: params.system,
      dedup_key: params.dedupKey,
      reported_ids: JSON.stringify(params.reportedIds),
      tech_trace_id: params.techTraceId,
      issue_id: params.issueId,
      occurred_at: params.occurredAt,
      status: params.status,
    })
    .onConflict((oc) => oc.column('dedup_key').doNothing())
    .returning('id')
    .executeTakeFirst()

  if (!inserted) return

  await db
    .updateTable('flow_trace')
    .set({ current_stage: params.stageName, last_activity_at: params.occurredAt })
    .where('id', '=', params.flowTraceId)
    .where('last_activity_at', '<=', params.occurredAt)
    .execute()
}
```

Test cases: (a) first insert creates the step and advances current_stage;
(b) a retried `dedupKey` is a no-op (current_stage unchanged, no duplicate
row); (c) a checkpoint with an earlier `occurredAt` than the trace's
current `last_activity_at` inserts the step (audit trail) but does **not**
regress `current_stage`.

Verify: typecheck, build, run tests (expect Postgres ECONNREFUSED as
established — no live Postgres in this sandbox). Commit.

## Task 2: `shared-types` — `FlowCheckpointSchema`

**Files:**
- Create: `packages/shared-types/src/flow.ts` + `.test.ts`
- Modify: `packages/shared-types/src/index.ts`

```ts
import { z } from 'zod'

export const FlowEntityIdSchema = z.object({ system: z.string(), entityId: z.string() })

export const FlowCheckpointSchema = z.object({
  stage: z.string(),
  system: z.string(),
  entityIds: z.array(FlowEntityIdSchema).min(1),
  dedupKey: z.string(),
  occurredAt: z.string().datetime(),
  techTraceId: z.string().nullable().optional(),
  issueId: z.string().nullable().optional(),
  status: z.enum(['ok', 'error']).default('ok'),
})
export type FlowCheckpoint = z.infer<typeof FlowCheckpointSchema>
```

Verify: typecheck, build, test (pure logic, should genuinely pass). Commit.

## Task 3: `ingest-api` — `POST /api/v1/flows/checkpoints`

**Files:**
- Create: `apps/ingest-api/src/routes/flow-checkpoints.ts` + `.test.ts`
- Modify: `apps/ingest-api/src/app.ts` (register the route)

Reuses the exact `bearerPublicKey` + `resolveProjectByPublicKey` pattern
from `releases.ts` (local helper, not extracted to a shared util — matches
that file's own existing precedent of duplicating this small helper rather
than sharing it). Validates the body against `FlowCheckpointSchema`, then
enqueues to `ingest.flow` via the existing `producer.send(...)` (same
`QueueProducer` used for every other queue), with the same
`RETRY_OPTS` used in `envelope.ts`. No `raw_envelope`-style archival here —
this is already a structured native JSON API, not a binary wire format
needing separate durable-archive replay.

```ts
app.post('/api/v1/flows/checkpoints', async (request, reply) => {
  const { db, redis, producer } = app.deps
  const publicKey = bearerPublicKey(request.headers.authorization)
  if (!publicKey) return reply.code(401).send({ error: 'missing bearer token' })

  const project = await resolveProjectByPublicKey(publicKey, { db, redis })
  if (!project) return reply.code(401).send({ error: 'unknown project' })

  const checkpoint = FlowCheckpointSchema.parse(request.body)
  await producer.send('ingest.flow', 'checkpoint', { projectId: project.id, checkpoint }, RETRY_OPTS)

  return reply.code(202).send({ status: 'accepted' })
})
```

Test with the same `waitForOneJob('ingest.flow')` BullMQ-Worker-based
helper already used in `envelope.test.ts`, plus a 401 case for a missing/
unknown key and a 400 case for a schema-invalid body.

Verify: typecheck, build, test (expect the auth/queue tests needing
Postgres to fail on ECONNREFUSED as established; the schema-validation
401/400 cases should genuinely pass without touching Postgres if written
to short-circuit before any DB call — check this matches `releases.test.ts`
precedent). Commit.

## Task 4: `flow-stitch-worker` (new app)

**Files:** new `apps/flow-stitch-worker/` mirroring `grouping-worker`'s
shape minus the internal producer (this worker only consumes, it doesn't
publish onward to another queue):
- `package.json`, `tsconfig.json`
- `src/consumer.ts` (identical BullMQ `Worker` wrapper used by every other
  worker app)
- `src/handle-message.ts` + `.test.ts`
- `src/main.ts`
- `src/consumer.test.ts` (real Queue/Worker round-trip against this
  sandbox's live Redis, per the established Task-4/5/6 precedent from the
  Kafka-removal phase)

```ts
export async function handleFlowCheckpointMessage(db: Kysely<Database>, data: unknown): Promise<void> {
  const { projectId, checkpoint } = data as { projectId: string; checkpoint: FlowCheckpoint }
  const flowTraceId = await attachOrCreateFlowTrace(db, { projectId, reportedIds: checkpoint.entityIds })
  await upsertFlowStep(db, {
    flowTraceId,
    stageName: checkpoint.stage,
    system: checkpoint.system,
    dedupKey: checkpoint.dedupKey,
    reportedIds: checkpoint.entityIds,
    techTraceId: checkpoint.techTraceId ?? null,
    issueId: checkpoint.issueId ?? null,
    occurredAt: new Date(checkpoint.occurredAt),
    status: checkpoint.status,
  })
}
```

`main.ts` follows the exact `transaction-worker`/`replay-worker` shape:
one cache `redis`, one dedicated `queueConnection` (`maxRetriesPerRequest:
null`), `startConsumer(queueConnection, 'ingest.flow', (data) =>
handleFlowCheckpointMessage(db, data))`.

Also: add `flow-stitch-worker` to `docker-compose.yml`'s service list if a
services-per-app pattern exists there already (check — as of the Kafka
removal, `docker-compose.yml` only lists infra services, not the Node apps
themselves, so this may be a no-op; confirm before assuming a change is
needed).

Verify: typecheck, build, test (`consumer.test.ts` should pass for real
against live Redis, matching every other worker's Task 4-6 precedent from
the Kafka-removal phase; `handle-message.test.ts` fails cleanly on
Postgres ECONNREFUSED). Commit.

## Task 5: `query-api` — `GET /api/v1/flows/:flowTraceId`

**Files:**
- Create: `apps/query-api/src/routes/flows.ts` + `.test.ts`
- Modify: `apps/query-api/src/app.ts`

```ts
app.get<{ Params: { flowTraceId: string } }>('/api/v1/flows/:flowTraceId', async (request, reply) => {
  const { db } = app.deps
  const trace = await db.selectFrom('flow_trace').selectAll().where('id', '=', request.params.flowTraceId).executeTakeFirst()
  if (!trace) return reply.code(404).send({ error: 'not found' })

  const steps = await db
    .selectFrom('flow_step')
    .selectAll()
    .where('flow_trace_id', '=', request.params.flowTraceId)
    .orderBy('occurred_at', 'asc')
    .execute()

  return { trace, steps }
})
```

Verify: typecheck, build, test (Postgres ECONNREFUSED as established).
Commit.

## Task 6: `flows_by_stage` widget

**Files:**
- Modify: `packages/shared-types/src/widgets.ts` (add `'flows_by_stage'`
  to `WidgetTypeSchema`, add `FlowsByStageConfigSchema` — likely just `{}`
  or a `windowDays` bound like the others, decide when writing)
- Modify: `apps/query-api/src/widgets/run-widget-query.ts` (add a
  `flowsByStage` query function + switch case)

```ts
async function flowsByStage(db: Kysely<Database>, config: WidgetConfigFor<'flows_by_stage'>, scope: WidgetScope) {
  return db
    .selectFrom('flow_trace')
    .select(['current_stage', sql<number>`count(*)`.as('count')])
    .where('project_id', '=', scope.projectId)
    .where('status', '=', 'in_progress')
    .groupBy('current_stage')
    .execute()
}
```

No web-side change needed for rendering — `WidgetChart.tsx` already
renders any array generically (confirmed by reading the current
implementation: it's a plain `data.map(row => <li>{JSON.stringify(row)}</li>)`,
not per-widget-type-specific), so this widget type "just works" once the
backend returns rows, matching every other widget's current MVP fidelity.

Verify: typecheck, build, test. Commit.

## Task 7: `web` — `FlowDetailPage`

**Files:**
- Create: `apps/web/src/pages/FlowDetailPage.tsx` + `.test.tsx`
- Modify: `apps/web/src/api/query-client.ts` (add `fetchFlow`)
- Modify: `apps/web/src/App.tsx` (add `/flows/:flowTraceId` route)

Mirrors `TraceDetailPage.tsx`'s exact shape (`useParams` → `useEffect` →
`fetchFlow` → render). Renders the trace's `current_stage`/`status`
header, then the ordered step list with `stage_name` / `system` /
`occurred_at`, and the gap duration since the previous step (the "absence
of activity between steps is the signal" from §10f) — computed client-side
from consecutive `occurred_at` values, no new backend field needed.

Verify: typecheck, build, test (MSW-mocked, should genuinely pass — no
Postgres dependency in a frontend unit test). Commit.

## Final verification

- `pnpm turbo run lint typecheck build --force`
- `pnpm --filter @flare/flow-stitch-worker test` and every touched app's
  test suite, confirming the same pass/fail split as every prior phase
  (pure-logic and live-Redis tests pass; Postgres-touching tests fail
  cleanly on `ECONNREFUSED`).
- Manual end-to-end check once Docker/Postgres are available: POST a
  checkpoint, confirm a `flow_trace`/`flow_step`/`flow_alias` row appears,
  confirm a second checkpoint reporting a translated id attaches to the
  same trace.

## What this plan deliberately does not build

- Real instrumentation of Dynamics/MDM/ClientHub/AMS2/AMS
  Surveying/Exchange/MIPortal — external system access required, not a
  code task.
- `flow_definition`/`flow_step_definition`, stall detection, the live
  "where is everything" board, the aggregate flow-map DAG, and deviation
  detection — all explicitly Phase 6 ("Flow tracing maturity") per the
  original roadmap.
- OpenAPI spec generation — cross-cutting, deferred to its own task.
- `tech_trace_id`/`issue_id` drill-down UI linking (the fields exist on
  `flow_step` for Phase 6 to wire up; this phase only stores them).
