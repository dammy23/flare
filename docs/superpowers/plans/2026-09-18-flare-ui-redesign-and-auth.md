# Flare — UI Redesign + In-App Auth (implementation plan)

New scope beyond the original roadmap's phases, requested directly: a
Sentry-like UI (different color identity) across the whole app, plus real
in-app authentication (registration, login, user management) — explicitly
chosen over the original "SSO at ingress, no in-app auth" assumption after
asking. This is the 9th executed implementation-plan phase in this repo.

## Architecture reversal (read first)

The original plan's header assumption was: "Auth for the Web UI / Query
API... via an ingress-level OIDC proxy... kept out of the Node app
entirely." That assumption is now superseded. `query-api` becomes a real
authenticated service:

- New `user`/`project_member`/`session` (Redis) model.
- `bcryptjs` for password hashing (pure JS, no native addon to
  cross-compile — same reasoning already used for KafkaJS/librdkafka in
  the original library-selection table).
- Sessions are opaque IDs stored in Redis (`session:<sid>` →
  `{ userId, createdAt }`, 7-day TTL), not JWTs — simpler to revoke
  (logout = delete the Redis key), and Redis is already infrastructure
  this stack runs. This is a step beyond Redis's previous "cache only,
  rebuildable" role: a Redis restart now logs everyone out rather than
  just resetting a rate-limit counter. Documented here as a deliberate,
  accepted trade-off, not an oversight — acceptable for an internal tool
  where "log in again" is a minor inconvenience, not data loss.
  `@fastify/cookie` (v9.x — the last major targeting Fastify v4, which
  this repo is still on) signs the session-ID cookie; no
  `@fastify/session` — the session lookup itself is a plain Redis GET,
  hand-rolled rather than pulling in a framework for something this
  small, consistent with this codebase's existing preference (e.g. the
  bespoke envelope parser over a library).
- `ingest-api`'s DSN-public-key auth is untouched — that's SDK-facing,
  not user-facing, and out of scope here.
- Bull Board (`query-api`'s `/admin/queues`) previously documented its
  lack of auth as intentional (relying on ingress SSO). Once real
  in-app auth exists, that reasoning no longer holds — it gets gated
  behind `requireAdmin` in this plan too, closing that previously-noted
  gap as a side effect of building real auth, not a separate ask.
- Permissions kept deliberately simple for this pass: `user.is_admin`
  (global flag) gates User Management and project create/delete/Bull
  Board. `project_member` exists to show/manage a project's roster but
  does **not** yet gate per-project data access — every logged-in user
  can see every project's issues/dashboards, same as today. Real
  per-project access control is flagged as follow-up work, not built
  now (avoids a full multi-tenant authorization matrix nobody asked
  for yet).
- First-ever registered user becomes admin automatically (bootstraps
  the system without a manual DB edit); everyone after that registers
  as a regular member.

## Visual identity

Sentry's identity is dark-purple/violet. Flare's take: a dark
slate/graphite base (`#14161a` background, `#1c1f26` surface) with a warm
**amber/orange "flare" accent** (`#ff8a3d` primary, `#ffb703` highlight)
as the brand color — distinct from Sentry's purple, thematically fitting
the name, same dark-mode-first developer-tool feel. Semantic colors keep
their conventional meaning (red = error/unresolved, green = resolved,
amber = warning/stalled) but tuned to sit against the graphite base
rather than Sentry's exact palette. Implemented as CSS custom properties
(design tokens) in one stylesheet, not a CSS-in-JS library — this app has
no styling dependency at all today, and one plain stylesheet is the
lightest option consistent with everything else in this codebase.

## Task breakdown (sequential; each verified + committed like every other
phase this session)

1. **Auth backend foundation** — `user`/`project_member` tables +
   `packages/db` helpers (`createUser`, `findUserByEmail`, password
   verify), Redis session helpers, `POST /api/v1/auth/register`,
   `POST /api/v1/auth/login`, `POST /api/v1/auth/logout`,
   `GET /api/v1/me` on `query-api`, and a `requireAuth`/`requireAdmin`
   preHandler applied to the existing `/api/v1/*` routes (except
   `/api/v1/auth/*` and `/healthz`).
2. **Design system foundation** — tokens stylesheet, app shell (sidebar
   nav + topbar), base components (Button, Card, Table, Badge, Input,
   EmptyState), wired into `web`'s existing pages structurally (routing/
   auth-gating) without yet re-skinning every page's content.
3. **Login/Register pages** + an `AuthProvider`/`useAuth` context gating
   the whole app behind a session check, redirecting to `/login` when
   unauthenticated.
4. **Project management UI** — project list/create page using the new
   shell+components; backend gains `GET /api/v1/projects` (list-all,
   currently only per-ID/create routes exist) and
   `DELETE /api/v1/projects/:id`, both `requireAdmin`.
5. **User management UI** — user list, role toggle (`is_admin`), backed
   by `GET /api/v1/users` / `PATCH /api/v1/users/:id` (`requireAdmin`).
6. **Issue pages reskin** — `IssueListPage`/`IssueDetailPage` rebuilt
   with the new components. Breadcrumbs: `event` has no breadcrumb
   storage yet despite the original schema plan calling for it (§2)
   — add an `event.breadcrumbs jsonb` column, thread it through
   ingest's envelope parsing (Sentry event items already carry a
   `breadcrumbs.values[]` array) and grouping-worker's insert, and
   render a breadcrumb timeline on the issue detail page. A real,
   previously-unbuilt gap, not a cosmetic-only task.
7. **Dashboard reskin** — `DashboardPage`/`WidgetChart` rebuilt on
   `recharts`, which the original library-selection table named for
   this exact purpose (§7) but was never installed — `WidgetChart` has
   been a plain JSON-dump list all session.
8. **Remaining pages reskin** — Replay list/detail, Trace detail, Flow
   board/map/detail, all restyled with the same components, no new
   backend work.

Each task gets its own commit(s) with the usual typecheck/build/test
verification. Given the size, this plan is executed across multiple
turns, not one — progress is reported task-by-task as it lands.
