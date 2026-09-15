# Flare — Technical Plan (Self-Hosted Observability Platform)

## Context

SOCOTEC (UK) needs an internal, self-hosted alternative to Sentry — "Flare" —
serving a small number of internal applications at low volume (low thousands
of events/day). The stack (Node.js/TypeScript backend, React/TypeScript
frontend), datastore (PostgreSQL, no ClickHouse), streaming layer (Apache
Kafka), object storage (S3/MinIO), and overall architecture (stateless
ingest → queue → workers → Postgres/object storage → query API → UI, with
Redis as shared cache/coordination) are fixed and not open for
re-recommendation. This document is the requested phased technical plan
covering all twelve deliverables: component breakdown, data model, ingest
envelope format, pipeline design, client integration, API surface, library
selection, deployment, per-project dashboards, business-flow tracing, a
phased roadmap, and risks.

Repo is currently empty (no existing code, not yet a git repo), so this is
greenfield planning — there is no existing codebase to reconcile against.
This plan is the input to a subsequent implementation plan (via
`writing-plans`) once reviewed.

## Assumptions (stated because no fixed decision covers them)

- **Kafka vs Redpanda:** the user has confirmed **Apache Kafka** (not
  Redpanda) — this plan runs Kafka in **KRaft mode** (no ZooKeeper), which
  keeps the "no separate coordination service" benefit Redpanda would have
  offered while staying on stock Kafka. `KafkaJS` (see §7) talks to it
  unmodified either way, so nothing in the app layer is Kafka-vs-Redpanda
  specific.
- **Local development:** the entire suite (Postgres, Kafka, Redis, MinIO,
  and every Node service) must run via **Docker Compose** for local dev,
  independent of the Kubernetes deployment target — see §8.
- **Kubernetes hosting:** generic self-hosted K8s (on-prem or any cloud) —
  no cloud-managed equivalents (RDS, MSK, EKS-specific add-ons) assumed
  available. If SOCOTEC already runs managed Postgres/S3, those should
  replace the in-cluster CloudNativePG/MinIO components directly — nothing
  else in the plan changes.
- **Auth for the Web UI / Query API:** not specified in the brief. Assumed
  to sit behind SOCOTEC's existing SSO (Azure AD/Entra ID, given the
  Microsoft-flavoured systems flow tracing touches) via an ingress-level
  OIDC proxy (e.g. `oauth2-proxy`) rather than Flare building its own login
  system — kept out of the Node app entirely, which is the lightest option.
- **HTTP framework:** Fastify (justified in §7).
- **Monorepo tooling:** pnpm workspaces + Turborepo, to share the
  `shared-types` package between backend and frontend without publishing an
  internal npm package per change.
- Flare's own observability of itself (logs/metrics) is out of scope for
  build but assumed to ride on whatever Prometheus/Grafana SOCOTEC already
  operates, not on Flare monitoring itself (chicken-and-egg — see §12).

---

## 1. Component Breakdown

| Component | Responsibility | Scaling |
|---|---|---|
| **ingest-api** | Stateless HTTP service. Two route families: Sentry-compatible envelope endpoint (`/api/<project_id>/envelope/`) and native flow-checkpoint API. Authenticates (public key → project via Redis-cached lookup), applies Redis-backed rate limits, does cheap shape validation (item type, size caps), and produces to Kafka. No DB writes, no CPU-heavy work. | Horizontal, stateless — K8s HPA on CPU/RPS. This is the request-path component where "lightweight" matters most; kept intentionally thin. |
| **grouping-worker** | Consumes `ingest.errors`. Normalizes stack trace structure, computes fingerprint (top-N in-app frames), upserts `issue` (by `project_id, fingerprint`), inserts `event`, updates `issue_environment`, bumps rollups. Publishes to internal `work.symbolication` topic for CPU-bound resolution. | Horizontal, KEDA-scaled on `ingest.errors` consumer-group lag. |
| **symbolication-worker** | Consumes `work.symbolication`. CPU-bound: resolves stack frames against uploaded source maps, using a Redis-shared resolved-frame cache. Isolated into its own Deployment so CPU spikes never starve ingest or grouping. Uses a `piscina` worker-thread pool internally (see §7). | Horizontal, independently KEDA-scaled on `work.symbolication` lag — the one pool most likely to need extra replicas after a big release. |
| **transaction-worker** | Consumes `ingest.transactions`. Writes `transaction`/`span` rows, maintains `transaction_latency_rollup` (p50/p95/p99) incrementally. | Horizontal, KEDA-scaled. |
| **replay-worker** | Consumes `ingest.replays` (`replay_event` + `replay_recording` item types). Writes segment blobs to object storage, metadata to `replay`/`replay_segment`. No server-side rrweb rendering — playback is client-side in the React UI. | Horizontal, KEDA-scaled; I/O-bound (object storage writes), not CPU-bound. |
| **attachment-worker** | Consumes `ingest.attachments`. Writes blobs to object storage, pointer row to `attachment`. | Horizontal, KEDA-scaled. |
| **flow-stitch-worker** | Consumes `ingest.flow`. Resolves entity identity via `flow_alias`, upserts `flow_trace`/`flow_step` idempotently on `dedup_key`. The highest-correctness-risk component (see §10). | Horizontal but bounded by `ingest.flow`'s deliberately low partition count (see §4); volume is tiny so this is not a bottleneck at stated scale. |
| **stall-detector** | K8s CronJob. Scans `flow_trace` rows `in_progress` past their current step's `expected_max_duration`, marks `stalled`. | Scheduled, not continuously running — cheap. |
| **retention-job** | K8s CronJob. Drives `pg_partman` partition creation/drop and MinIO lifecycle rule reconciliation. | Scheduled. |
| **query-api** | Stateless HTTP service backing the Web UI: issues, events, traces, replays, dashboards, widget-data, flow visualizations. Reads Postgres, optionally serves widget responses from Redis cache, issues presigned URLs for object-storage blobs (replay segments, source maps). | Horizontal, stateless. |
| **web** | React/TS SPA. Static build served behind the ingress (no server-side rendering needed). | Static assets — trivially horizontal / can sit behind any CDN or just multiple nginx pods. |
| **Redis** | Shared cache/coordination only: rate-limit counters, `public_key → project` cache, `environment string → environment_id` cache, symbolication resolved-frame cache, optional widget-data cache. **Never a system of record.** | Single instance acceptable at this scale (see §8); state is all rebuildable. |
| **Kafka** | Durable ingest buffer + pipeline backbone (KRaft mode, no ZooKeeper). Topics described in §4. | 3-broker cluster (recommended) for HA, since retention is explicitly relied on as the durable buffer. |
| **PostgreSQL** | System of record for everything: issues, events, spans, replay metadata, releases, dashboards, flow traces. | Single primary + replica via CloudNativePG; partitioned tables for cheap retention (§2). No sharding needed at this volume. |
| **MinIO/S3** | Large blobs: source maps, replay segments, attachments. | Object storage, scales independently of everything else. |

---

## 2. Data Model

Core tables (types abbreviated; all `id` columns are UUID unless noted):

**project** `(id, name, slug, public_key, created_at)` — one DSN (`public_key`) per project; no secret key, no environment in the DSN.

**environment** `(id, project_id, name, created_at)`, `UNIQUE(project_id, name)`. Auto-created on first sighting by the ingest path (§3).

**release** `(id, project_id, version, created_at)`, `UNIQUE(project_id, version)`.

**source_map_artifact** `(id, release_id, file_path, storage_key, content_type, created_at)`, `UNIQUE(release_id, file_path)` — Postgres holds only the pointer; the file itself is in object storage.

**issue** `(id, project_id, fingerprint, title, culprit, type, status, first_seen, last_seen, times_seen, grouping_raw_components JSONB)`, `UNIQUE(project_id, fingerprint)`. `grouping_raw_components` stores the raw frames/values that fed the fingerprint so regrouping is possible later without re-parsing raw events.

**issue_environment** `(issue_id, environment_id, first_seen, last_seen, times_seen)`, `PK(issue_id, environment_id)` — lets the UI answer "unresolved in production, last 24h" without scanning `event`.

**event** *(partitioned monthly by `timestamp` via pg_partman)* `(id, project_id, issue_id, environment_id, release_id, event_id UUID, timestamp, level, message, exception JSONB, breadcrumbs JSONB, tags JSONB, user_context JSONB, contexts JSONB, received_at)`. `UNIQUE(project_id, event_id)` for idempotent envelope retries. Breadcrumbs live as JSONB on the row — no separate infrastructure, per the brief. At this volume, every event is stored (no down-sampling needed); retention is controlled purely via partition drop.

**issue_rollup_daily** `(project_id, issue_id, environment_id, day, count)` — pre-aggregated so chart widgets don't scan `event` partitions for date-range queries.

**transaction** *(partitioned monthly)* `(id, project_id, environment_id, release_id, trace_id, name, op, start_ts, duration_ms, status)`.

**span** *(partitioned monthly, indexed on `trace_id`)* `(id, transaction_id, trace_id, span_id, parent_span_id, op, description, start_ts, duration_ms)`.

**transaction_latency_rollup** `(project_id, environment_id, transaction_name, hour_bucket, p50, p95, p99, count)` — maintained incrementally by `transaction-worker` so the UI never computes percentiles over raw spans live.

**replay** `(id, project_id, environment_id, issue_id NULL, session_id, duration_ms, segment_count, error_count, started_at)`.

**replay_segment** `(replay_id, sequence, storage_key, size_bytes, started_at)`, `PK(replay_id, sequence)`.

**attachment** `(id, project_id, event_id, storage_key, filename, content_type, size_bytes)`.

**dashboard** `(id, project_id, name, env_selector_default, created_at)`, `UNIQUE(project_id)` — one dashboard per project by design, with the schema change to drop that constraint noted as the escape hatch if multi-dashboard is ever needed.

**dashboard_widget** `(id, dashboard_id, widget_type, title, layout JSONB, config JSONB, environment_mode ENUM('inherit','pin'), pinned_environment_id NULL, layout_updated_at, config_updated_at)` — layout and config are saved independently (two PATCH paths, two timestamps) because drag-resize and "edit this widget's query" are different UI actions with different validation (layout is unconstrained x/y/w/h; config is validated against the widget-type catalog schema).

**flow_definition** `(id, project_id, name, description)`.

**flow_step_definition** `(id, flow_definition_id, stage_name, sequence_order, expected_max_duration INTERVAL, is_terminal BOOLEAN)`.

**flow_trace** `(id, project_id, flow_definition_id NULL, status ENUM('in_progress','completed','stalled','abandoned'), current_stage, started_at, last_activity_at, completed_at NULL)`.

**flow_step** `(id, flow_trace_id, stage_name, system, dedup_key, reported_ids JSONB, tech_trace_id NULL, issue_id NULL, occurred_at, received_at, status ENUM('ok','error'))`, `UNIQUE(dedup_key)` — idempotent upsert target for retries/out-of-order arrival.

**flow_alias** `(id, flow_trace_id, system, entity_id, first_seen, last_seen)`, `UNIQUE(system, entity_id)` — the identity-stitching table (detailed in §10). This is the single most important index in the schema: every checkpoint's first act is a lookup here.

**Indexes worth calling out:** `issue(project_id, status, last_seen DESC)` for the issue list; `event(project_id, issue_id, timestamp DESC)` and `event(project_id, environment_id, timestamp DESC)` for filtered views; `span(trace_id)` for trace lookup; `flow_alias(system, entity_id)` (the unique constraint already covers this); `flow_step(flow_trace_id, occurred_at)` for swimlane rendering.

**Partitioning & retention:** `event`, `transaction`, and `span` are range-partitioned by month via `pg_partman`, which pre-creates future partitions and drops old ones as a metadata-only operation (detach + drop) rather than a row-by-row `DELETE` — this is how retention stays cheap as volume grows. Suggested defaults: `event` 90 days, `transaction`/`span` 30 days (both are heavily sampled at ingest anyway — see §4/§6), `replay_segment` metadata 30 days paired with a matching MinIO bucket lifecycle rule on the actual segment blobs. `issue`, `issue_environment`, and the rollup tables are small (bounded by distinct issue/day cardinality, not raw event volume) and are **not** time-partitioned — kept indefinitely. `flow_trace`/`flow_step`/`flow_alias` are kept much longer (e.g. 1 year) given the low volume and high audit value of business-flow data; not partitioned initially, revisit only if retention needs to extend past several years.

---

## 3. Ingest Envelope Format

The Sentry envelope format is newline-delimited: an envelope header JSON line, then repeated pairs of an item-header JSON line and an item payload. Because payloads (attachments, replay recordings) can be binary and contain raw `\n` bytes, the parser must be byte-accurate, not a naive `split('\n')`:

1. Read up to the first `\n` → parse as the envelope header JSON (`{event_id, dsn?, sent_at}`). Headers are always single-line JSON and therefore safe to split on.
2. Loop: read up to the next `\n` → parse as an item header (`{type, length?, content_type?}`).
   - If `length` is present, the payload is exactly that many raw bytes — slice by byte count (safe for binary payloads), then advance past the trailing `\n`.
   - If `length` is absent (some SDKs omit it for JSON items), the payload runs to the next `\n`.
3. Repeat until the buffer is exhausted.

**Where `environment` sits:** it is a top-level field inside the `event`/`transaction` item payload (Sentry's `environment` SDK init option already serializes there) — no change needed to any off-the-shelf SDK.

**Resolution before writing to Kafka:**
- `public_key → project`: parsed from `X-Sentry-Auth` header (`Sentry sentry_version=7, sentry_key=<key>, ...`, comma-separated key=value pairs), falling back to the `?sentry_key=` query param. Looked up via Redis (`dsn:<public_key> → project_id`, short TTL e.g. 5 min) with Postgres as the source of truth on cache miss.
- `environment string → environment_id`: looked up via Redis (`env:<project_id>:<name> → environment_id`); on miss, `INSERT ... ON CONFLICT (project_id, name) DO NOTHING RETURNING id` against Postgres (or a follow-up `SELECT` if the conflict fired), then cached. This is the concrete mechanism behind "auto-create environments on first sighting."

Once both are resolved, the Kafka message carries the raw item payload plus `project_id`, `environment_id`, `received_at` — workers never need to re-resolve either.

---

## 4. Pipeline Design

**Topics** (partitioned by `project_id`, moderate partition counts — e.g. 6–12 — sufficient for horizontal worker scaling without operating an over-partitioned cluster at this volume):

- `ingest.errors` → grouping-worker
- `ingest.transactions` → transaction-worker
- `ingest.replays` → replay-worker
- `ingest.attachments` → attachment-worker
- `work.symbolication` (internal, not an ingest topic — produced by grouping-worker after the initial upsert, consumed by symbolication-worker) — kept separate specifically so CPU-bound resolution scales independently of I/O-bound grouping (§1, §7)
- `ingest.flow` → flow-stitch-worker, **intentionally low partition count (1–3)**: it cannot be partitioned meaningfully by entity ID, since the entity is re-keyed mid-journey (§10), and volume is tiny (hundreds–thousands/day) so a low partition count is not a throughput constraint. Correctness here comes from DB constraints (`dedup_key`, `flow_alias` uniqueness), not from partition ordering.

**Consumer groups:** one per worker type, matching the table in §1.

**Ordering/idempotency:** every write in the pipeline is upsert-based specifically so Kafka's at-least-once delivery and possible out-of-order arrival are safe:
- Issue upsert: `INSERT ... ON CONFLICT (project_id, fingerprint) DO UPDATE SET last_seen = GREATEST(...), times_seen = times_seen + 1`.
- Event insert: `INSERT ... ON CONFLICT (project_id, event_id) DO NOTHING` (client-generated `event_id` is the idempotency key for envelope retries).
- Flow step upsert: `INSERT ... ON CONFLICT (dedup_key) DO NOTHING` (or `DO UPDATE` if a later report should be allowed to enrich an earlier one — decide per-field on implementation).

**Worker concurrency:** each worker pod runs Kafka consumers with I/O-bound stages (Postgres upserts) processed through a bounded concurrency pool (e.g. `p-limit`, sized to the pod's share of `max_connections`) so a single pod handles multiple in-flight messages without blocking on each round-trip. CPU-bound work (symbolication) is offloaded to a `piscina` worker-thread pool so the Kafka-consuming main thread never blocks (detailed in §7).

---

## 5. Client Integration

Two paths, exactly as fixed in scope — no bespoke SDKs maintained by Flare for either.

### 5a. Sentry-protocol-compatible ingest (standard telemetry)

- **Endpoint:** `POST /api/<project_id>/envelope/`, parsed per §3.
- **Auth:** `X-Sentry-Auth` header (primary), `?sentry_key=` query param (fallback) — both resolve to a project via the Redis-cached lookup in §3.
- **Item routing:**

  | Item type | Topic |
  |---|---|
  | `event` | `ingest.errors` |
  | `transaction` | `ingest.transactions` |
  | `replay_event`, `replay_recording` | `ingest.replays` |
  | `attachment` | `ingest.attachments` |
  | `session`, `client_report` | Accepted (200), not enqueued — logged as a counter metric for visibility, dropped otherwise. Not implementing session-health scoring is an explicit scope choice; revisit only if a team asks for it. |

- **Responses:** `200 {"id": "<event_id>"}` on success, matching what SDKs expect from the envelope endpoint. On rate-limit: `429` with `X-Sentry-Rate-Limits: <retry_after>:<category>:key` (Sentry's documented format, comma-joined for multiple categories) and `Retry-After: <seconds>` — this exact shape is what makes off-the-shelf SDK transports self-throttle correctly, so it's implemented byte-for-byte rather than approximated. Rate-limit counters (token bucket per `project_id` + category — `error`/`transaction`/`replay`/`attachment`) live in Redis so all `ingest-api` replicas share one limit.
- **Source-map upload path:** `sentry-cli` (unmodified, off-the-shelf) drives release creation (`POST /api/0/.../releases/`) and per-file artifact upload (`POST .../releases/<version>/files/`). Flare implements the subset of the Release/Artifact API those two `sentry-cli` subcommands call. **Assumption:** target the legacy per-file `files/` endpoint rather than the newer artifact-bundle (zip+manifest) upload, since it's simpler and still supported — flag artifact-bundle support as a fast-follow if any team's `sentry-cli` version forces it.
- **Legacy `/api/<id>/store/` endpoint:** explicitly skipped. It's the pre-envelope, single-JSON-POST protocol Sentry itself deprecated years ago; every current SDK defaults to the envelope endpoint, and since SOCOTEC controls which SDK versions its own internal apps pin, there's no reason to support it.

### 5b. Native HTTP/JSON flow-checkpoint API

Kept off the envelope endpoint entirely, since the Sentry protocol has no journey concept to reuse. `POST /api/v1/flows/checkpoints` accepting a JSON body matching `flow_step` (`stage`, `system`, `entity_ids`, `dedup_key`, `occurred_at`, optional `tech_trace_id`/`issue_id`). **Assumption:** authenticated with the same project DSN public key as the envelope endpoint (one credential story, rather than inventing a second key type) via a simple bearer/header scheme — good enough given this is an internal, trusted-network API and third-party callers (Dynamics webhooks) are already going through a controlled integration.

### 5c. OpenAPI spec

Generated from the same `zod` schemas the Fastify routes validate against (via `zod-to-openapi` — see §7), so the spec cannot drift from the actual validators. Published at `/openapi.json`, covering the envelope endpoint (useful for internal debugging even though most callers are SDKs), the flow checkpoint API, the release/artifact upload API, and the full query/dashboard API — so any team can generate a typed client in their own language on demand, with zero SDKs maintained by Flare.

---

## 6. API Surface

| Endpoint | Purpose |
|---|---|
| `POST /api/<project_id>/envelope/` | Sentry-compatible ingest (§5a) |
| `POST /api/0/organizations/<org>/releases/` | Create a release (sentry-cli) |
| `POST /api/0/.../releases/<version>/files/` | Upload a source-map/artifact file (sentry-cli) |
| `POST /api/v1/flows/checkpoints` | Native flow checkpoint ingest (§5b) |
| `GET /api/v1/projects/<id>/issues` | Issue list, filterable by status/environment/time range |
| `GET /api/v1/issues/<id>` | Issue detail + recent events |
| `GET /api/v1/issues/<id>/events` | Paged event list for an issue |
| `GET /api/v1/traces/<trace_id>` | Trace lookup — transaction + spans |
| `GET /api/v1/replays/<id>` | Replay metadata + presigned segment URLs |
| `GET /api/v1/projects/<id>/dashboard` | Fetch the project's single dashboard + widgets |
| `PATCH /api/v1/widgets/<id>/layout` | Save layout only |
| `PATCH /api/v1/widgets/<id>/config` | Save config only (validated against widget-type catalog) |
| `POST /api/v1/widgets` / `DELETE /api/v1/widgets/<id>` | Add/remove a widget |
| `GET /api/v1/widgets/<id>/data` | Generic widget-data endpoint (§9) |
| `GET /api/v1/flows/<flow_trace_id>` | Journey detail (swimlane data) |
| `GET /api/v1/flows/board` | "Where is everything" live board, grouped by current stage |
| `GET /api/v1/flows/map` | Aggregate flow-map DAG (per-edge throughput/duration) |
| `GET /openapi.json` | Published OpenAPI spec (§5c) |

---

## 7. Library Selection (within the fixed Node.js/TS + React stack)

| Concern | Choice | Why |
|---|---|---|
| HTTP framework | **Fastify** | TS-first, schema-validation built in (pairs with `zod`), lower overhead than Nest — matches the "lightweight in the request path" goal for `ingest-api` specifically. |
| Kafka client | **KafkaJS** | Pure JS, no native addon to cross-compile in multi-arch Docker builds — matches "lightweight ops." `confluent-kafka-javascript` (librdkafka bindings) is the noted escape hatch if throughput ever becomes a real bottleneck, which is unlikely at this volume. |
| Kafka mode | **KRaft (no ZooKeeper)** | User has confirmed Apache Kafka over Redpanda. Running it in KRaft mode (Kafka's built-in consensus, GA since 3.x) drops the separate ZooKeeper process without leaving stock Kafka — the closest equivalent to Redpanda's "one thing to run" property while staying on the mainline project. |
| Sentry envelope parsing | **Bespoke, in-house (~150 LOC)** | No mature server-side (ingestion-oriented) npm package exists for this; `@sentry/core`'s internals are client-oriented. The format is small and fully documented (§3), so writing it directly is lower-risk than adopting a client-side-shaped dependency. |
| Source-map resolution | **`@jridgewell/trace-mapping`** | Actively maintained, fast; the legacy `source-map` package is effectively unmaintained. Used by tools like esbuild for the same purpose. |
| rrweb replay handling | **`rrweb` (client, via the Sentry SDK's own Replay integration) + `@rrweb/replay` in the React UI** | Flare's server does no rrweb processing — it stores/streams segment blobs; rendering is entirely client-side, keeping the replay-worker I/O-bound rather than CPU-bound. |
| Redis client | **`ioredis`** | Feature-complete, well-maintained, supports Sentinel/Cluster if ever needed. |
| Postgres access + migrations | **Kysely** (typesafe query builder) **+ `node-pg-migrate`** for migrations | Prisma's codegen/runtime is heavier and fights the fine-grained control needed for `ON CONFLICT` upserts and `pg_partman`-partitioned tables; Kysely gives typed SQL without an ORM's abstraction tax. |
| React dashboard grid | **`react-grid-layout`** | As suggested — mature, drag/resize grid, matches the per-project widget layout model directly. |
| Charting (widget catalog) | **`recharts`** | The widget catalog is a fixed set of vetted chart shapes (time series, bar, percentile lines) — `recharts` gets there fastest with good defaults. |
| Bespoke visualizations (flow swimlane, flow-map DAG) | **Raw SVG + `dagre`** (graph layout) for the DAG | These are not off-the-shelf chart types; `recharts` doesn't fit, so they're built directly rather than forced into a charting library. |
| CPU-bound worker isolation | **Node `worker_threads`, wrapped by `piscina`** | Built-in threading primitive; `piscina` adds pool management/backpressure so the symbolication-worker doesn't hand-roll a task queue. |
| Shared types | **`zod`**, defined once in a `packages/shared-types` workspace package | Used by both the Fastify route validators (server-side) and the React widget-config form (client-side) — this is the literal mechanism behind the "one type for the widget-catalog config, shared client/server" requirement. Also feeds `zod-to-openapi` for the published spec. |
| Monorepo tooling | **pnpm workspaces + Turborepo** | Lighter than Nx for a handful of packages (`ingest-api`, `query-api`, workers, `web`, `shared-types`); avoids publishing an internal npm package per shared-type change. |

**On Node's single-threaded model — the main place the Node-only constraint is strained:** the symbolication and replay-processing paths are the two CPU-bound hotspots in an otherwise I/O-bound system. The mitigation has four parts: (1) symbolication is its own Deployment (`symbolication-worker`), never sharing a process with `ingest-api` or `grouping-worker`, so a CPU spike there cannot add latency to the request path; (2) within each `symbolication-worker` pod, a `piscina` worker-thread pool (sized to the pod's CPU request, e.g. 2–4 threads) keeps the main thread free to keep consuming from Kafka while threads do the actual frame-resolution work; (3) `work.symbolication` has its own KEDA-driven HPA, scaled independently of every other worker type; (4) the Redis resolved-frame cache means steady-state cost is dominated by cache hits — CPU pressure concentrates specifically around new releases, which is exactly when K8s HPA scaling up temporarily is the right response. If this ever isn't enough at higher volume, the escape hatch is more replicas of that one Deployment — not a second language, per the fixed decision.

---

## 8. Deployment Plan

Two deployment targets, kept deliberately close to each other: **Docker
Compose for local development** and **Kubernetes for everything else**
(shared/staging/production). The same container images are used in both —
Compose just runs them with simpler networking and no operator layer.

### 8a. Local development — Docker Compose

A single `docker-compose.yml` at the repo root brings up the entire suite
with one command, no Kubernetes required for day-to-day development:

- `postgres` (plain `postgres` image, `pg_partman` extension installed via
  an init script — same schema/migrations as production, just unpartitioned
  test volumes)
- `kafka` (KRaft mode, single broker — Kafka ships an official image that
  runs KRaft without ZooKeeper, so this is a single container, not two)
- `redis` (plain `redis` image)
- `minio` (plain `minio` image, with a start-up step that creates the
  buckets `ingest-api` otherwise assumes exist)
- one service per Node component (`ingest-api`, `query-api`,
  `grouping-worker`, `symbolication-worker`, `transaction-worker`,
  `replay-worker`, `attachment-worker`, `flow-stitch-worker`,
  `stall-detector`, `retention-job`, `web`), each built from the same
  `Dockerfile` per package (multi-stage, shared base layer) used for the K8s
  images — built with `docker compose build`, run with `docker compose up`.

Every service reads its Kafka/Postgres/Redis/MinIO connection info from
environment variables with the same names in both Compose and K8s, so no
compose-specific code paths exist in the app — Compose is purely an
orchestration-layer choice, not an app-layer one. This is set up in Phase 0
(§11) alongside the K8s manifests, not bolted on afterward.

### 8b. Kubernetes (shared/staging/production)

**Namespace:** single `flare` namespace.

**Stateless Deployments** (all horizontally scaled, most via KEDA on Kafka-lag): `ingest-api`, `query-api`, `grouping-worker`, `symbolication-worker`, `transaction-worker`, `replay-worker`, `attachment-worker`, `flow-stitch-worker`, `web` (static React build).

**Stateful components:**
- **PostgreSQL** via the **CloudNativePG** operator — primary + one replica, `pg_partman` extension enabled from day one (retrofitting partitioning onto a live table is painful, so it's set up even in the MVP phase even though early volume wouldn't strictly need it). Automated backups via `pgBackRest` (bundled with CNPG). PVC-backed.
- **Kafka** (KRaft mode, no ZooKeeper) via the **Strimzi** operator — **3-broker cluster** recommended, since Kafka retention is explicitly relied on as the durable ingest buffer and shouldn't be a single point of failure. A single-broker deployment is the true minimum-footprint option if ops appetite is lower, with the explicit caveat that a restart loses whatever's in flight beyond consumer offsets already committed.
- **MinIO** — small tenant with lifecycle rules matching the retention windows in §2 (or swap for SOCOTEC's existing S3-compatible storage if one exists — pure config change, nothing in the app layer depends on MinIO specifically).
- **Redis** — single instance, no Sentinel/Cluster needed initially: everything it holds (rate-limit counters, DSN cache, symbolication cache) is cheap to rebuild after a restart, and Kafka remains the durable source of truth regardless. Escape hatch to Sentinel only if rate-limit resets during a restart become an actual problem in practice — unlikely.

**Scheduled workloads:** `stall-detector` and `retention-job` (partition maintenance) as K8s CronJobs.

**Autoscaling:** KEDA installed cluster-wide, scaling each worker Deployment on its own consumer-group lag rather than raw CPU — the right signal for a queue-driven pipeline.

**Ingress:** split into two rule sets — one for `ingest-api` (public-facing from internal client apps, rate-limit/auth posture tuned for high-volume automated traffic) and one for `query-api`/`web` (internal dashboard traffic, sat behind SOCOTEC SSO per the assumption in the header).

**Secrets:** K8s Secrets for Postgres/Redis/Kafka credentials. DSN public keys are not secret by design (Sentry's own DSN model) and don't need secret storage.

---

## 9. Per-Project Dashboards

One dashboard per project (`UNIQUE(project_id)` on `dashboard`), auto-provisioned on project creation with the starter widget catalog pre-populated (`issues_over_time`, `top_issues`, `new_issues`, `events_by_environment` in a default layout) — so a new project is immediately useful without manual setup. The `UNIQUE` constraint is the deliberately narrow MVP scope; the escape hatch to multiple dashboards per project is dropping that constraint and adding a `dashboard.name`-scoped selector in the UI, with no other schema change needed since `dashboard_widget` already references `dashboard_id`, not `project_id`.

**Widget-type catalog** — each type is a vetted, parameterized query the backend owns; there is no raw user SQL anywhere in this feature:

| Widget type | Backing query shape |
|---|---|
| `issues_over_time` | Count of new+recurring events by day, from `issue_rollup_daily`, filtered by environment |
| `top_issues` | Top-N `issue` rows by `times_seen` in a window, joined to `issue_environment` for the selected environment |
| `new_issues` | `issue.first_seen` within a window |
| `events_by_environment` | Count from `issue_rollup_daily` grouped by `environment_id` |
| `event_volume` / `error_rate` | Count from `issue_rollup_daily` (or a parallel `event_rollup_daily` if non-issue events need counting), ratio over total transaction count for error-rate |
| `transaction_latency` (p50/p95/p99) | Directly from `transaction_latency_rollup`, filtered by `transaction_name`/environment |
| `replay_count` | Count from `replay`, filtered by environment/time |
| `flows_by_stage` | Count of `flow_trace.current_stage`, grouped, from `flow_trace` (§10) |

**Config vs layout:** `dashboard_widget.config` is JSONB validated against a per-widget-type `zod` schema (the same schema instance the React config form uses to render/validate its fields — the concrete shared-type mechanism from the Fixed Decisions). `layout` (`{x, y, w, h}`) is unconstrained beyond grid bounds and saved via a separate `PATCH .../layout` call, so dragging a widget never re-validates its query config and vice versa.

**Environment selector:** the dashboard has a top-level environment selector (`env_selector_default`, e.g. "production"). Each widget's `environment_mode` is either `inherit` (follows the dashboard selector — the default) or `pin` (locked to `pinned_environment_id` regardless of the dashboard-level selection) — covers the case where one widget on an otherwise prod-focused dashboard should always show, say, staging error volume.

**Widget-data endpoint:** `GET /api/v1/widgets/<id>/data` is generic — every widget fetches independently rather than the dashboard endpoint returning all widget data inline, so slow widgets don't block fast ones and the UI can retry/refresh one widget at a time. Responses are optionally cached in Redis with a short TTL (e.g. 30–60s), keyed by `(widget_type, config_hash, resolved_environment_id, time_range)` — these queries repeat heavily (every dashboard viewer re-runs the same aggregate query), so this cache does real work despite the short TTL.

---

## 10. Business-Flow / Activity Tracing

Distinct from technical tracing: this traces a *business entity* (a workorder) across independent systems over hours-to-days, with async handoffs and some hops that can't be instrumented directly.

### 10a. Identity stitching (highest-risk piece — planned first)

Systems re-key the entity mid-journey: Dynamics creates `WO-123`, MDM masters it as `MASTER-456`, ClientHub calls it `CH-789` — one journey, three IDs. Each checkpoint reports whatever IDs its own system knows, plus any translation it just performed (e.g. ClientHub's checkpoint says "I received `MASTER-456` from MDM and am now calling it `CH-789`"). The `flow-stitch-worker`:

1. For each ID in the checkpoint's `reported_ids`, looks up `flow_alias(system, entity_id)`.
2. If any lookup hits, attach the checkpoint to that `flow_trace`; register any *new* `(system, entity_id)` pairs from this checkpoint into `flow_alias`.
3. If no lookup hits, create a new `flow_trace` and register all reported IDs as fresh aliases.

**Before building this**, produce a "which system calls the entity what, and where translations happen" matrix as its spec — this is the artifact that de-risks the whole feature, because a wrong or ambiguous mapping silently merges two unrelated journeys or fails to link one. Sketch for the example scenario:

| Hop | System | Calls the entity | Translation performed |
|---|---|---|---|
| 1 | Dynamics | `WO-<n>` | none (originates ID) |
| 2 | MDM | `MASTER-<n>` | `WO-<n> → MASTER-<n>` |
| 3 | ClientHub | `CH-<n>` | `MASTER-<n> → CH-<n>` |
| 4 | AMS2 | (internal AMS2 ID) | `CH-<n> → AMS2-<id>` |
| 5 | AMS Surveying | (survey job ID) | `AMS2-<id> → SURVEY-<id>` |
| 6 | AMS2 (return) | (internal AMS2 ID) | `SURVEY-<id> → AMS2-<id>` (already an alias — attaches, doesn't create) |
| 7 | Exchange service → MIPortal | (MIPortal reference) | `AMS2-<id> → MIPORTAL-<id>` |

This table (validated with each system owner, not guessed) is the actual deliverable that should exist before a line of the stitching worker is written.

### 10b. Idempotent, order-independent checkpoints

`flow_step.dedup_key` is unique — retries and out-of-order arrival are both safe via `ON CONFLICT (dedup_key) DO NOTHING`. `ingest.flow` deliberately has a low partition count (§4) since correctness comes from these DB constraints, not from Kafka ordering.

### 10c. Per-system instrumentation matrix

| System type | Instrumentation approach |
|---|---|
| Own apps (AMS2, ClientHub, AMS Surveying) | Thin HTTP call to `POST /api/v1/flows/checkpoints` at each meaningful state change |
| Middleware / Exchange service | High-leverage chokepoint — instrument once here to cover every message that flows through it, rather than instrumenting every system on both sides |
| Dynamics | Webhook/business-event handler seeds the *first* checkpoint and the initial alias (Dynamics can't run custom code, but can fire outbound webhooks on record events) |
| Opaque systems (no webhook, no API) | CDC/outbox tap if available; scheduled polling as the last resort — explicitly the lossiest, highest-latency option, used only when nothing else is possible |

### 10d. Linking to technical tracing

`flow_step.tech_trace_id` and `flow_step.issue_id` are optional foreign-key-ish fields (soft references, since traces/issues may be in different retention windows or projects). This is the core reason both tracing layers live in one tool: a stalled or failed business step drills straight down into the technical span trace or Flare error from that same step, rather than requiring someone to manually correlate timestamps across two separate tools.

### 10e. Stall detection

`stall-detector` CronJob marks `flow_trace` rows `stalled` when `now() - last_activity_at > current step's expected_max_duration` (from `flow_step_definition`). This is a primary source of value on its own — "which workorders are stuck between AMS Surveying and AMS2 for more than 24h" is exactly the query this enables.

### 10f. Visualizations

- **Per-journey swimlane** — `flow_step` rows for one `flow_trace` on a timeline, with handoff gaps drawn explicitly (the *absence* of activity between steps is the signal, not just the steps themselves).
- **Live "where is everything" board** — `flow_trace` grouped by `current_stage` (same query backs the `flows_by_stage` dashboard widget).
- **Aggregate flow-map DAG** — nodes are stages, edges are observed transitions, annotated with throughput and mean duration per edge — built from `flow_step` sequences, rendered with `dagre` layout + raw SVG (§7).
- **Deviation detection** — comparing an actual `flow_trace`'s step sequence against its `flow_definition`'s expected `flow_step_definition` sequence to flag skipped or looped stages.

---

## 11. Phased Roadmap

Each phase ships something independently usable.

**Phase 0 — Platform skeleton.** Monorepo scaffold (`pnpm` + Turborepo), `shared-types` package, Postgres schema + migrations (partitioned from day one), Docker Compose for the full local stack (§8a) alongside Kafka/Redis/MinIO K8s manifests (§8b) for staging/prod, `ingest-api` skeleton with DSN auth + Redis-backed rate limiting, CI pipeline.

**Phase 1 — MVP: error ingestion + grouping.** Envelope endpoint handling `event` items only; `grouping-worker` upserting `issue`/`event`; environment auto-create + per-environment filtering; issue list + issue detail UI showing raw (unsymbolicated) stack traces; unresolved/resolved status. No source maps, no replay, no tracing, no dashboards beyond a plain issue list, no flow tracing yet. This alone is "Sentry-lite for errors" and is immediately useful.

**Phase 2 — Symbolication + releases.** Release/artifact upload API (`sentry-cli`-compatible), `symbolication-worker` + Redis resolved-frame cache, source-mapped stack traces in the UI.

**Phase 3 — Dashboards MVP.** `dashboard`/`dashboard_widget` tables, auto-provisioned default dashboard, starter catalog minus the tracing/replay/flow widgets (`issues_over_time`, `top_issues`, `new_issues`, `events_by_environment`), generic widget-data endpoint + Redis cache, `react-grid-layout` UI, environment selector (dashboard-level + per-widget inherit/pin).

**Phase 4 — Technical tracing + replay.** `transaction`/`span` ingestion, `transaction-worker` + latency rollups, trace lookup UI, `transaction_latency` widget; replay ingestion, `replay-worker`, in-browser rrweb playback, `replay_count` widget.

**Phase 5 — Business-flow tracing MVP.** `flow_definition`/`flow_step_definition`/`flow_trace`/`flow_step`/`flow_alias` tables, native checkpoint API, `flow-stitch-worker`, published OpenAPI spec, first instrumentation targets (Exchange service as the chokepoint + one or two own apps + Dynamics webhook seeding), basic swimlane UI, `flows_by_stage` widget. Gated on the identity-stitching matrix (§10a) being validated with system owners first.

**Phase 6 — Flow tracing maturity.** `stall-detector`, live "where is everything" board, aggregate flow-map DAG with throughput/duration, deviation detection, `tech_trace_id`/`issue_id` drill-down linking.

**Phase 7 — Hardening.** Retention automation running in production (partition drop + MinIO lifecycle), basic alerting ("new issue", frequency threshold — via email/Slack webhook), backup/restore drills, load validation against real traffic.

---

## 12. Risks & Open Questions

- **Identity stitching is the single highest-risk piece.** A wrong or ambiguous ID mapping silently merges unrelated journeys or fails to link one, and there's no way to detect this automatically. Mitigate by validating the "who calls it what" matrix with every system owner before building (§10a), and plan a manual admin split/merge operation as a human escape hatch for bad stitches discovered after the fact — not committed to a phase above, worth adding once Phase 5 is underway.
- **Opaque third-party systems remain the weak link** for both flow-tracing completeness and technical-trace correlation. CDC/polling taps are inherently lossy and higher-latency than a direct checkpoint call; this is a permanent constraint, not something Phase 6 fixes.
- **Postgres as sole system of record is fine at stated volume** (low thousands/day) but is the component most sensitive to volume growth. If technical-tracing sampling or replay volume grows well beyond plan, the escape hatch is tightening sampling rates and shortening retention windows first — reaching for a columnar store is explicitly out of scope and shouldn't be revisited without a much larger volume shift than described here.
- **`ingest.flow`'s low partition count is a deliberate trade-off**, fine at hundreds–thousands/day. If flow volume grew by one to two orders of magnitude, the `flow-stitch-worker`'s consumption would be bounded by that partition count in a way scaling replicas can't fix (can't partition meaningfully by entity ID, as noted) — the real escape hatch there would be re-keying the topic by originating system instead, not something to build now.
- **"Lightweight" is relative, not absolute.** Even with every individual piece kept lean, this is still four stateful systems to operate on Kubernetes (Postgres, Kafka, Redis, MinIO). Worth surfacing to stakeholders explicitly as "lightweight compared to a Sentry/ClickHouse/multi-region stack," not "zero-ops." Running Kafka specifically (vs. Redpanda) means the Strimzi operator and JVM-based brokers are part of that footprint — accepted per explicit instruction, but worth naming as the one place "lightweight ops" is traded for staying on stock Kafka.
- **Sentry-protocol compatibility is a moving target.** Sentry's SDKs and envelope format evolve over time; this needs an owned compatibility test suite (real SDK-generated fixture envelopes run through the parser/validators) as an ongoing artifact, not a one-time build-and-forget.
- **Self-monitoring chicken-and-egg**, noted in the Assumptions: decide explicitly whether Flare eventually points its own services at itself once stable, or stays on plain K8s/Prometheus indefinitely.
- **Redis is non-HA by design** (single instance) — acceptable because everything it holds is cache/coordination state, rebuildable, with Kafka as the actual durable buffer; worst case on a Redis restart is a brief rate-limit reset, not data loss.

---

## Verification & Next Steps

This is a planning artifact, not code — "verification" here means review, not test execution:

1. Circulate §10a's identity-stitching matrix to the AMS2/ClientHub/AMS Surveying/Dynamics/Exchange/MIPortal system owners for confirmation *before* Phase 5 starts — this is the one section most likely to be wrong without their input.
2. Confirm the assumptions in the header (K8s hosting environment, SSO/auth approach for the Web UI, whether SOCOTEC already runs a shared Kafka cluster this could join instead of standing up a dedicated one) with whoever owns platform infrastructure.
3. Once this plan is accepted, produce a `writing-plans`-style implementation plan for **Phase 0 + Phase 1** specifically (bite-sized, TDD, file-by-file) — that's the right grain for an execution plan; this document is intentionally one level up from that.
