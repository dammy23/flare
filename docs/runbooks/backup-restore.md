# Backup & Restore Runbook

**Status: not yet executed.** No CloudNativePG cluster exists to drill
against yet, in this sandbox or in production. This document exists so
the procedure is reviewed and ready *before* there's a real cluster to
run it against, per the original architecture plan's deployment section
(`flare-technical-plan.md`, §8b) and the Hardening phase's plan doc.

## What "backup" means here

Postgres is Flare's sole system of record (per the original plan's
Fixed Decisions). The deployment plan assumes the **CloudNativePG**
operator, which bundles **pgBackRest** for:

- **Continuous WAL archiving** — every committed transaction's WAL
  segments are shipped continuously to object storage (MinIO/S3), not
  just at backup time. This is what makes point-in-time recovery
  possible between base backups, not just recovery to the last backup.
- **Scheduled base backups** — CloudNativePG's own `ScheduledBackup`
  resource, typically daily, producing a full base backup that later
  WAL replay is anchored to.

Kafka is gone (removed in an earlier phase); nothing else in this stack
needs its own backup story — Redis is documented cache/coordination
state only (rebuildable, never a system of record), and MinIO/S3 object
storage (source maps, replay segments) would use the storage
provider's own bucket replication/versioning if that level of
durability is ever required, which is a separate decision from this
runbook.

## Triggering a restore drill

1. **Do not restore into the production cluster.** Provision a
   throwaway CloudNativePG `Cluster` resource in a scratch namespace,
   pointed at the same backup location, with a `bootstrap.recovery`
   spec referencing either the latest base backup or a specific
   point-in-time target.
2. Wait for the recovered cluster to report `Ready`.
3. Point a throwaway `query-api` instance's `DATABASE_URL` at the
   recovered cluster (never at production) — reuse the same container
   image, just different connection config.
4. Verification checklist (run against the recovered instance, not
   production):
   - `SELECT count(*) FROM issue`, `event`, `flow_trace` — row counts
     should be in the same order of magnitude as production's, not
     zero and not wildly higher (a wildly higher count would suggest
     the wrong backup/timestamp was restored).
   - `SELECT max(last_seen) FROM issue` — should be recent relative to
     the backup's timestamp, not stale by days (a stale timestamp
     means WAL replay didn't actually apply, and the restore silently
     landed on the base backup alone).
   - Hit `GET /api/v1/projects/:projectId/issues` through the
     throwaway `query-api` and confirm it returns data shaped like
     production's, not an error.
5. Tear down the throwaway cluster and `query-api` instance. Record the
   actual wall-clock time the drill took, start to `Ready` to verified
   — that number is the real answer to "how long would we be down," not
   an estimate.

## Cadence

Run this drill on a schedule, not only after an incident — a backup
that has never been restored is unverified by definition. A quarterly
cadence is a reasonable starting point; tighten it if a drill ever
turns up a problem (a broken WAL archive, a `ScheduledBackup`
misconfiguration, a restore that takes longer than the team's actual
recovery-time expectation), since a caught problem means the next drill
should happen sooner, not later.

## Open items before this can actually run

- A CloudNativePG cluster (staging or production) needs to exist.
- The backup object-storage location (bucket/credentials) needs to be
  provisioned and wired into the `Cluster` resource's
  `backup.barmanObjectStore` config.
- Whoever runs the first drill should update this document with the
  actual commands used (this runbook describes the procedure, not a
  copy-pasteable script, since the exact CloudNativePG manifest depends
  on the cluster's actual name/namespace/storage config once one
  exists).
