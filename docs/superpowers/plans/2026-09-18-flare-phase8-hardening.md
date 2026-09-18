# Flare — Hardening (implementation plan)

Corresponds to **Phase 7** in the original architecture plan's roadmap
(`flare-technical-plan.md`, §11): "Retention automation running in
production (partition drop + MinIO lifecycle), basic alerting ('new
issue', frequency threshold — via email/Slack webhook), backup/restore
drills, load validation against real traffic." It is the 8th executed
implementation-plan phase in this repo. Also folds in the authorization-
consistency pass flagged as Phase-7-appropriate work during the prior
phase's security review (project-scoping across `query-api`'s by-ID
detail routes).

## Scope decisions

- **Retention automation — a real gap found while planning this phase**:
  `event` was correctly range-partitioned via `pg_partman` back in Phase 0
  (`retention = '90 days'`), but `transaction`/`span` were never actually
  partitioned in Phase 4 despite the original plan calling for it (§2).
  Retrofitting partitioning onto `span` specifically is non-trivial here:
  `span.transaction_id` is a plain FK to `transaction.id`, and Postgres
  requires a partitioned table's FK-referenced columns to include its
  partition key — meaning `transaction` can't be repartitioned by
  `start_ts` without either restructuring that FK (dropping it, or
  widening it to `(transaction_id, start_ts)` and carrying `start_ts` onto
  `span` too) or leaving `span` unpartitioned on purpose. This is a real
  schema-migration decision that deserves its own reviewed plan and a
  live Postgres to validate against before running — not something to
  attempt blind in a Docker-less sandbox as a side effect of a hardening
  pass. **Decision: flagged here explicitly, not fixed in this phase.**
  What *is* built: a `retention-job` script that runs `pg_partman`
  maintenance for the tables that are actually partitioned (`event`
  today), and applies MinIO/S3 lifecycle rules for `replay_segment`
  blobs (30-day expiration on the `replays/` key prefix, matching every
  service's already-shared single bucket).
- **Basic alerting**: Slack incoming webhook only (a `fetch` POST, no new
  dependency) — email is skipped as a first channel; the original plan
  says "via email/Slack webhook" (either), and Slack's webhook is
  strictly simpler to implement and verify (no SMTP client/credentials
  needed). Two triggers: a brand-new issue, and an issue's `times_seen`
  crossing a single configured threshold (fires once, at the exact
  crossing — not on every occurrence after).
- **Backup/restore drills**: this is an operational runbook against
  CloudNativePG/pgBackRest, which don't exist in this sandbox (no
  Kubernetes, no CloudNativePG operator). Nothing to *build* — a runbook
  document is written instead, so the procedure exists and is reviewable
  before there's a real cluster to run it against.
- **Load validation against real traffic**: inherently requires a
  deployed environment and actual traffic; there is no code artifact for
  this in a Docker-less, trafficless sandbox. Explicitly out of scope,
  flagged rather than faked.
- **Authorization consistency**: `issues.ts`, `traces.ts`, `replays.ts`,
  and `flows.ts` in `query-api` all fetch by bare ID with no project
  scoping (flagged by an automated security review during the flow-
  tracing phase, acknowledged then as consistent-but-real). Fixed here
  across all four at once, not piecemeal — the whole point of deferring
  it was to do it as one consistent pass instead of special-casing one
  route.

## Task 1: `retention-job` — pg_partman maintenance + MinIO lifecycle

**Files:** new `apps/retention-job/` (`package.json`, `tsconfig.json`,
`src/run-partition-maintenance.ts` + `.test.ts`, `src/run.ts`); modify
`packages/storage/src/create-storage-client.ts` (+`applyLifecycleRule`).

`runPartitionMaintenance(db)`: `SELECT partman.run_maintenance()` — this
is pg_partman's own maintenance entrypoint; it creates upcoming
partitions and drops/detaches ones past their configured retention for
every table registered in `partman.part_config` (today: just `event`).
Nothing Flare-specific to compute — pg_partman already owns this logic
once `create_parent`/`retention` are configured, which Phase 0 already
did for `event`.

`applyLifecycleRule(prefix, expirationDays)` on `StorageClient`: wraps
`PutBucketLifecycleConfigurationCommand` (verified against the installed
`@aws-sdk/client-s3` types via typecheck, not assumed). `run.ts` calls
it once for `replays/` at 30 days, matching §2's suggested retention.

Verify: typecheck, build, test (ECONNREFUSED as established for the
Postgres-touching function; the lifecycle-rule call can't be exercised
against real MinIO either, since port 9000 is closed in this sandbox —
verified via typecheck against the real SDK types instead, same
posture as every other untestable-live-infra piece this session).
Commit.

## Task 2: Basic alerting (Slack webhook)

**Files:** new `apps/grouping-worker/src/alerts/send-slack-webhook.ts` +
`.test.ts`; modify `apps/grouping-worker/src/upsert-issue-event.ts` (+
`title`/`timesSeen` on `UpsertResult`), `src/handle-message.ts`, `src/main.ts`.

`sendSlackWebhook(webhookUrl, text)`: a plain `fetch` POST with Slack's
`{ text }` payload shape; logs (doesn't throw) on a non-2xx response, so
a broken webhook URL can never take down error ingestion itself --
alerting is a side effect, not a dependency of the write path.

`handleErrorMessage` gains a 5th parameter,
`alerting: { webhookUrl: string | null; frequencyThreshold: number }`,
defaulted to `{ webhookUrl: null, frequencyThreshold: 100 }` so every
existing call site (and every existing test) keeps working unchanged --
alerting is opt-in and a no-op without a configured webhook URL. `main.ts`
reads `SLACK_WEBHOOK_URL`/`ALERT_FREQUENCY_THRESHOLD` and passes them
through, following the same "read env in main.ts, inject everywhere
else" convention already used for every other dependency in this app.

Verify: typecheck, build, test (`send-slack-webhook.test.ts` mocks
`fetch`, should genuinely pass; `handle-message.test.ts`/
`upsert-issue-event.test.ts` fail on Postgres ECONNREFUSED as
established). Commit.

## Task 3: Authorization consistency across `query-api` detail routes

**Files:** modify `apps/query-api/src/routes/{issues,traces,replays,flows}.ts`
+ their `.test.ts` files.

Every by-ID detail route gains a required `?projectId=` query param,
resolved and enforced before the by-ID lookup: `.where('project_id', '=',
projectId)` on the primary row's query (and, where the child rows don't
carry `project_id` directly -- `event`, `span`, `flow_step` -- scoping is
enforced transitively through the already-project-scoped parent row, not
by adding a redundant join). A request for a real ID under the wrong
`projectId` (or with no `projectId` at all) gets `404`, identical to an
unknown ID -- not `401`/`403` -- so this doesn't leak whether an ID
exists under a different project. This still isn't authentication (no
bearer token, no SSO check in-app -- that boundary is unchanged, and
still documented in `queue-board.ts`/this plan as ingress-level); it
closes the specific IDOR gap the review flagged (fetching *any* ID's
full detail with zero relationship to the caller's own project), not the
broader "no in-app auth" architecture.

This changes existing endpoint contracts (`GET /api/v1/issues/:issueId`
now requires `?projectId=`), so `apps/web`'s callers
(`query-client.ts`'s `fetchIssue`/`fetchTrace`/`fetchReplay`/`fetchFlow`
and their pages) are updated to pass it through too.

Verify: typecheck, build, test across `query-api` and `web`. Commit.

## Task 4: Backup/restore runbook (documentation)

**Files:** new `docs/runbooks/backup-restore.md`.

A reviewable procedure for the eventual CloudNativePG/pgBackRest setup:
what "backup" means here (pgBackRest continuous WAL archiving + the
CNPG operator's scheduled base backups, per the original deployment
plan §8b), how to trigger a restore drill (spin up a new CNPG cluster
from a backup, point a throwaway `query-api` at it, verify row counts/
recent timestamps match), and how often a drill should run. Explicitly
marked as **not yet executed** -- no CloudNativePG cluster exists to
drill against in this sandbox or in production yet.

No verification beyond a read-through; it's not code.

## Final verification

- `pnpm turbo run lint typecheck build --force`
- Confirm the established pass/fail split holds everywhere touched.

## What this plan deliberately does not build

- Repartitioning `transaction`/`span` (see Scope decisions) -- flagged
  as a dedicated follow-up requiring its own migration plan and a live
  Postgres to validate against.
- Email alerting channel.
- Any load-testing tooling or actual load-test run.
- Actually running a backup/restore drill.
