# Flare

Flare is a self-hosted, lightweight error-tracking and observability
platform for SOCOTEC — a Sentry alternative built on a fixed stack of
Node.js/TypeScript, React, PostgreSQL, Redis, and S3/MinIO, with no Kafka
and no ClickHouse.

It ingests errors via the standard Sentry envelope protocol (existing
Sentry SDKs work unmodified), groups them into issues, resolves stack
traces against uploaded source maps, tracks releases, renders
per-project dashboards, captures technical traces and session replays,
and stitches together cross-system business-process journeys (a
work order moving through Dynamics → MDM → ClientHub → AMS2, for
example) — all behind real in-app authentication.

## Contents

- [Architecture](#architecture)
- [Tech stack](#tech-stack)
- [Project layout](#project-layout)
- [Getting started](#getting-started)
- [Running the apps](#running-the-apps)
- [Feature overview](#feature-overview)
- [Environment variables](#environment-variables)

## Architecture

Flare is a pnpm/Turborepo monorepo. The request-path service
(`ingest-api`) is kept deliberately thin: it authenticates via a
project's DSN public key, does cheap shape validation, archives the
raw envelope bytes to Postgres for durable replay, and enqueues work
onto Redis-backed BullMQ queues. Everything CPU- or I/O-heavy — error
grouping, symbolication, transaction/replay processing, business-flow
stitching — happens in dedicated worker processes consuming those
queues, so a spike in one pipeline never adds latency to ingestion
itself.

```
SDK → ingest-api → raw_envelope (Postgres, durable archive)
                 → BullMQ queue (Redis)
                      → grouping-worker      → issue/event, publishes work.symbolication
                      → symbolication-worker → resolves stack frames against source maps
                      → transaction-worker   → transaction/span, latency rollups
                      → replay-worker        → replay segments → object storage
                      → flow-stitch-worker   → business-flow identity stitching

query-api  → reads Postgres, serves the web UI and the widget/dashboard API
web        → React SPA (issues, dashboards, traces, replays, flow tracing, admin settings)

stall-detector / retention-job → scheduled scripts (partition maintenance,
                                   MinIO lifecycle rules, stalled-flow detection)
```

There is no Kafka: BullMQ (Redis) handles work dispatch, and the
Postgres `raw_envelope` table is the durable, replayable archive that
would otherwise have been Kafka's job — see
`apps/ingest-api/src/scripts/replay-raw-envelopes.ts` for the backfill/
replay tool.

## Tech stack

| Concern | Choice |
|---|---|
| Backend | Node.js, TypeScript, [Fastify](https://fastify.dev) |
| Frontend | React, TypeScript, [Vite](https://vitejs.dev), React Router |
| Database access | [Kysely](https://kysely.dev) (typed SQL, no ORM) + [node-pg-migrate](https://github.com/salsita/node-pg-migrate) |
| Datastore | PostgreSQL (sole system of record), Redis (queues, sessions, cache — never a system of record) |
| Object storage | S3-compatible (MinIO locally) |
| Queues | [BullMQ](https://docs.bullmq.io) |
| Auth | Real in-app sessions — bcrypt password hashing, signed cookies, Redis-backed sessions |
| Alerting | Slack incoming webhooks, SMTP email (both optional/opt-in) |
| Validation | [Zod](https://zod.dev), shared between server and client via `@flare/shared-types` |
| Monorepo | pnpm workspaces + [Turborepo](https://turbo.build) |
| Tests | [Vitest](https://vitest.dev), [Testing Library](https://testing-library.com), [MSW](https://mswjs.io) |

## Project layout

```
apps/
  ingest-api/           Sentry-envelope-compatible ingest endpoint (DSN auth)
  query-api/             Web UI's backend: auth, issues, dashboards, projects,
                         users, traces, replays, flow tracing, Bull Board
  grouping-worker/       Error grouping + issue/event persistence, alerting
  symbolication-worker/  Stack-frame resolution against source maps
  transaction-worker/    Transaction/span persistence, latency rollups
  replay-worker/         Session replay segment storage
  flow-stitch-worker/    Business-flow identity stitching
  stall-detector/        Marks stalled business-flow traces (scheduled script)
  retention-job/         pg_partman maintenance + MinIO lifecycle rules (scheduled script)
  web/                   React SPA

packages/
  db/                    Postgres schema, migrations, and typed data-access functions
  shared-types/          Zod schemas shared between backend and frontend
  storage/               S3/MinIO client wrapper
```

## Getting started

**Prerequisites:** Node.js 20+, pnpm 9 (`packageManager` pins `9.12.0`),
and Postgres 16 + Redis 7 + MinIO reachable locally (a `docker-compose.yml`
is provided for all three).

```bash
# 1. Start infrastructure
docker compose up -d

# 2. Install dependencies
pnpm install

# 3. Run database migrations
pnpm --filter @flare/db migrate:up

# 4. Copy environment defaults
cp .env.example .env
```

## Running the apps

Each app builds and runs independently (`pnpm --filter <name> <script>`):

| App | Default port | Start command |
|---|---|---|
| `@flare/ingest-api` | 3000 | `pnpm --filter @flare/ingest-api start` |
| `@flare/query-api` | 3001 | `pnpm --filter @flare/query-api start` |
| `@flare/web` | 5173 (Vite dev) | `pnpm --filter @flare/web dev` |
| every worker (`grouping-worker`, `transaction-worker`, `replay-worker`, `symbolication-worker`, `flow-stitch-worker`) | — | `pnpm --filter @flare/<worker-name> start` |
| `stall-detector` / `retention-job` | — | `pnpm --filter @flare/<name> start` (intended to run on a schedule, e.g. a Kubernetes CronJob) |

Workspace-wide commands (via Turborepo, respecting each package's
dependency graph):

```bash
pnpm build       # build every package/app
pnpm typecheck   # typecheck everything
pnpm test        # run every test suite
pnpm lint        # lint everything
```

The web app registers the first account created as an admin
automatically — visit `/register` once the stack is running to bootstrap
the system; every account after that registers as a regular member.

## Feature overview

- **Sentry-compatible ingestion** — the envelope protocol, DSN auth, and
  rate-limit headers match Sentry's own SDK expectations closely enough
  that existing Sentry SDKs work against Flare unmodified.
- **Error grouping & symbolication** — fingerprint-based issue grouping,
  release/source-map upload (`sentry-cli`-compatible), stack-frame
  resolution with a Redis-cached resolver.
- **Breadcrumbs** — captured on ingest and rendered as a timeline on the
  issue detail page.
- **Dashboards** — a per-project dashboard auto-provisioned with a
  starter widget catalog (issue volume, top issues, event/environment
  breakdowns, transaction latency, replay counts, flow-by-stage).
- **Technical tracing & replay** — transaction/span ingestion with
  latency rollups; session replay segment storage with client-side
  playback.
- **Business-flow tracing** — a native checkpoint API for tracking a
  business entity across independent systems that re-key it along the
  way (e.g. a work order known by different IDs in different systems),
  with identity stitching, a live "where is everything" board, an
  aggregate flow-map, deviation detection, and stall detection.
- **Real authentication** — registration, login, sessions; project and
  user management UI, both admin-gated.
- **Alerting** — Slack webhook and/or email notifications for new
  issues and configurable frequency thresholds.
- **Retention automation** — `pg_partman`-driven partition maintenance
  for `event`, and MinIO lifecycle rules for replay segment blobs.

## Environment variables

See `.env.example` for the minimal local-dev set (`DATABASE_URL`,
`REDIS_URL`). Additional variables used by individual apps:

| Variable | Used by | Purpose |
|---|---|---|
| `PORT` | `ingest-api`, `query-api` | HTTP port (defaults shown in the table above) |
| `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET` | apps touching object storage | MinIO/S3 connection |
| `COOKIE_SECRET` | `query-api` | Signs the session cookie — set a real secret in any non-local environment |
| `SLACK_WEBHOOK_URL`, `ALERT_FREQUENCY_THRESHOLD` | `grouping-worker` | Slack alerting (opt-in) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `ALERT_EMAIL_FROM`, `ALERT_EMAIL_TO` | `grouping-worker` | Email alerting (opt-in — only active when `SMTP_HOST` and `ALERT_EMAIL_TO` are both set) |
| `VITE_QUERY_API_URL` | `web` | Base URL of `query-api` (defaults to `http://localhost:3001`) |
| `VITE_PROJECT_ID` | `web` | Default project shown on first load |
