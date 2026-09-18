# Flare — Flow Tracing Maturity (implementation plan)

This corresponds to **Phase 6** in the original architecture plan's roadmap
(`flare-technical-plan.md`, §11): "stall-detector, live 'where is everything'
board, aggregate flow-map DAG with throughput/duration, deviation
detection, tech_trace_id/issue_id drill-down linking." It is the 7th
executed implementation-plan phase in this repo (following
`2026-09-18-flare-phase6-business-flow-tracing-mvp.md`, which built the
generic checkpoint/stitching MVP this phase now builds on).

## Scope decisions

- **`flow_definition`/`flow_step_definition`** were deliberately deferred
  out of the MVP phase specifically because this phase needs them. Built
  here now: both tables, plus an `ALTER TABLE flow_trace ADD
  flow_definition_id` column (nullable — a trace is not required to be
  tied to a formal definition; deviation/stall detection is a no-op for
  traces without one).
- **Flow-map DAG rendering**: the original plan calls for "raw SVG +
  `dagre`" for this specific visualization (§7), explicitly *not* fitting
  the generic `recharts`/widget-catalog path. Given this whole web app's
  established fidelity level so far (`WidgetChart.tsx` is a literal
  `data.map(row => <li>{JSON.stringify(row)}</li>)` — every widget/detail
  page renders plain data, no charting library is wired up anywhere yet),
  building a real `dagre`-laid-out SVG graph here would be a large,
  disproportionate jump in frontend investment relative to everything else
  in the app. **Scope trim**: the backend endpoint
  (`GET /api/v1/flows/map`) is built in full (nodes, edges, per-edge count
  and mean duration), but the web page renders it as a plain edge list
  (`from -> to: count, avg duration`), matching every other page's current
  fidelity. Upgrading to an actual SVG DAG is flagged as a follow-up, not
  built now — this is the same kind of explicit trim already applied to
  `WidgetChart` in Phase 3 and never revisited since.
- **stall-detector** is built as a standalone script (`apps/stall-detector`),
  not a long-running worker — matching the original plan's "K8s CronJob,
  not continuously running" characterization (§1). No Docker/K8s exists in
  this sandbox to actually schedule it, so it's built and unit-tested as a
  script, same posture as `replay-raw-envelopes.ts`'s backfill script from
  the Kafka-removal phase.
- **Deviation detection** only evaluates traces with a `flow_definition_id`
  set (comparing the distinct stage sequence actually observed in
  `flow_step` against the expected `flow_step_definition` order for that
  definition). Traces without one simply have no deviation data — this
  is not an error case, it's the expected shape for the (currently: all)
  traces created via the MVP checkpoint API, which never sets
  `flow_definition_id` today. Wiring the checkpoint API to accept one is
  explicitly out of scope here (no caller needs it yet, would be
  speculative).

## Task 1: `flow_definition`/`flow_step_definition` tables + `flow_trace.flow_definition_id`

**Files:**
- `packages/db/migrations/1700000000020_create-flow-definition.cjs`
- `packages/db/migrations/1700000000021_create-flow-step-definition.cjs`
- `packages/db/migrations/1700000000022_add-flow-trace-definition-id.cjs`
- `packages/db/src/schema.ts` (+`FlowDefinitionTable`,
  `FlowStepDefinitionTable`, add `flow_definition_id` to `FlowTraceTable`)

```
flow_definition: id uuid pk, project_id uuid fk->project cascade,
  name text not null, description text null

flow_step_definition: id uuid pk, flow_definition_id uuid fk->flow_definition cascade,
  stage_name text not null, sequence_order integer not null,
  expected_max_duration interval null, is_terminal boolean not null default false
  index (flow_definition_id, sequence_order)

flow_trace: + flow_definition_id uuid null, references flow_definition, ON DELETE SET NULL
```

Verify: typecheck, build, migration files load without syntax error
(`require()` sanity check, no live Postgres). Commit.

## Task 2: `apps/stall-detector` — mark stalled traces

**Files:** new `apps/stall-detector/` (`package.json`, `tsconfig.json`,
`src/mark-stalled-traces.ts` + `.test.ts`, `src/run.ts`).

`markStalledTraces(db, now)`: for every `in_progress` trace with a
`flow_definition_id`, look up the `flow_step_definition` row matching its
`current_stage`; if `expected_max_duration` is set and
`now - last_activity_at > expected_max_duration`, set `status =
'stalled'`. Traces with no `flow_definition_id`, or whose current stage
has no `expected_max_duration` configured, are left alone (nothing to
compare against). Implemented as one SQL statement using an `interval`
comparison rather than a per-row loop, for the same reason the rollup
tables exist elsewhere in this codebase — this runs on a schedule and
should be a single query, not N.

`run.ts` is the CLI entrypoint (`node dist/run.js`), analogous to the
backfill script's shape but simpler (no arguments).

Verify: typecheck, build, test (Postgres ECONNREFUSED as established).
Commit.

## Task 3: Deviation detection

**Files:** `packages/db/src/detect-flow-deviations.ts` + `.test.ts`,
exported from `packages/db/src/index.ts`.

```ts
export interface FlowDeviations {
  expectedStages: string[]
  observedStages: string[]
  skippedStages: string[]   // expected but never observed
  unexpectedStages: string[] // observed but not in the definition
}

export async function detectFlowDeviations(db, flowTraceId): Promise<FlowDeviations | null>
```

Returns `null` when the trace has no `flow_definition_id` (nothing to
compare against — see Scope decisions). Otherwise: `expectedStages` from
`flow_step_definition` ordered by `sequence_order`; `observedStages` are
the distinct `stage_name`s from that trace's `flow_step` rows in
first-occurrence order; `skippedStages` = expected minus observed;
`unexpectedStages` = observed minus expected. (Looping/repeat visits to
the same stage are a separate signal from "wrong order" and out of scope
for this MVP-of-maturity pass — flagged, not built, same discipline as
everywhere else in this plan.)

Wire into `query-api`'s existing `GET /api/v1/flows/:flowTraceId`: add a
`deviations` field to the response (computed only when `trace.flow_definition_id`
is set).

Verify: typecheck, build, test. Commit.

## Task 4: `query-api` — board and map endpoints

**Files:** modify `apps/query-api/src/routes/flows.ts` + `.test.ts`.

`GET /api/v1/flows/board?projectId=<id>`: `in_progress`/`stalled` traces
for a project, grouped by `current_stage` — the "where is everything"
live view (§10f). Returns `{ stage: string; traces: { id, status,
lastActivityAt }[] }[]`.

`GET /api/v1/flows/map?projectId=<id>`: aggregate DAG data. For every
trace, walk its `flow_step` rows ordered by `occurred_at` and emit
`(fromStage, toStage, durationMs)` for each consecutive pair; group by
`(fromStage, toStage)`, returning `{ from, to, count, avgDurationMs }[]`.
Implemented with a `LAG()` window function over `flow_step` joined to
`flow_trace` for project scoping, not an application-level loop (this is
exactly the kind of aggregate the DB should do, consistent with how
every other rollup/widget query in this codebase works).

Verify: typecheck, build, test (ECONNREFUSED as established). Commit.

## Task 5: `web` — board page, map page, drill-down links

**Files:**
- `apps/web/src/pages/FlowBoardPage.tsx` + `.test.tsx`
- `apps/web/src/pages/FlowMapPage.tsx` + `.test.tsx` (plain edge list per
  the Scope decisions trim, not an SVG DAG)
- Modify `apps/web/src/pages/FlowDetailPage.tsx`: render a link to
  `/traces/:techTraceId` when a step's `tech_trace_id` is set, and to
  `/issues/:issueId` when `issue_id` is set; render `deviations` (skipped/
  unexpected stages) when present in the response.
- Modify `apps/web/src/api/query-client.ts` (`fetchFlowBoard`,
  `fetchFlowMap`, extend `FlowStepDto`/response types for
  `tech_trace_id`/`issue_id`/`deviations`)
- Modify `apps/web/src/App.tsx` (routes for `/projects/:projectId/flows/board`
  and `/projects/:projectId/flows/map`)

Verify: typecheck, build, test (MSW-mocked, should genuinely pass).
Commit.

## Final verification

- `pnpm turbo run lint typecheck build --force`
- Confirm every new/changed test suite's pass/fail split matches the
  established pattern (pure-logic and live-Redis tests pass; Postgres-
  touching tests fail cleanly on `ECONNREFUSED`).

## What this plan deliberately does not build

- An actual `dagre`-laid-out SVG flow-map graph (see Scope decisions) —
  the data endpoint is real, the rendering is a plain list.
- Looping/repeat-visit deviation detection (only skipped/unexpected-stage
  detection is built).
- Wiring the checkpoint API to accept `flow_definition_id` — no caller
  needs it yet.
- Actually scheduling `stall-detector` (no K8s CronJob/cron exists in
  this sandbox to schedule against) — it's built and tested as a runnable
  script, matching the backfill script's precedent.
