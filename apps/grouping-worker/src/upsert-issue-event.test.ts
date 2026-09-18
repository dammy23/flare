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
      releaseId: null,
      fingerprint: 'fp-1',
      event,
    })

    expect(result.created).toBe(true)
    expect(result.timesSeen).toBe(1)
    expect(result.title).toContain('Error')

    const issue = await db.selectFrom('issue').selectAll().where('id', '=', result.issueId).executeTakeFirstOrThrow()
    expect(issue.times_seen).toBe(1)
  })

  it('bumps times_seen and reuses the issue on a repeat fingerprint', async () => {
    const { projectId, environmentId } = await seedProjectAndEnvironment()
    const eventA = { event_id: 'evt-a', environment: 'production', exception: { values: [{ type: 'Error', value: 'boom' }] } }
    const eventB = { event_id: 'evt-b', environment: 'production', exception: { values: [{ type: 'Error', value: 'boom' }] } }

    const first = await upsertIssueAndEvent(db, { projectId, environmentId, releaseId: null, fingerprint: 'fp-repeat', event: eventA })
    const second = await upsertIssueAndEvent(db, { projectId, environmentId, releaseId: null, fingerprint: 'fp-repeat', event: eventB })

    expect(second.issueId).toBe(first.issueId)
    expect(second.created).toBe(false)
    expect(second.timesSeen).toBe(2)

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

    const first = await upsertIssueAndEvent(db, { projectId, environmentId, releaseId: null, fingerprint: 'fp-retry', event })
    const retry = await upsertIssueAndEvent(db, { projectId, environmentId, releaseId: null, fingerprint: 'fp-retry', event })

    const events = await db
      .selectFrom('event')
      .selectAll()
      .where('project_id', '=', projectId)
      .where('event_id', '=', 'evt-retry')
      .execute()
    expect(events).toHaveLength(1)

    // The retry must resolve to the real Postgres row id, not fall back
    // to the client-supplied event_id string (the bug this session found
    // and fixed alongside threading releaseId through).
    expect(retry.eventId).toBe(first.eventId)
    expect(retry.eventId).toBe(events[0].id)
  })

  it('stores breadcrumbs when the event carries them', async () => {
    const { projectId, environmentId } = await seedProjectAndEnvironment()
    const event = {
      event_id: 'evt-breadcrumbs',
      environment: 'production',
      exception: { values: [{ type: 'Error', value: 'boom' }] },
      breadcrumbs: { values: [{ category: 'ui.click', message: 'button#submit', level: 'info' }] },
    }

    const result = await upsertIssueAndEvent(db, {
      projectId,
      environmentId,
      releaseId: null,
      fingerprint: 'fp-breadcrumbs',
      event,
    })

    const stored = await db.selectFrom('event').selectAll().where('id', '=', result.eventId).executeTakeFirstOrThrow()
    expect(stored.breadcrumbs).toEqual({ values: [{ category: 'ui.click', message: 'button#submit', level: 'info' }] })
  })

  it('stores null breadcrumbs when the event carries none', async () => {
    const { projectId, environmentId } = await seedProjectAndEnvironment()
    const event = {
      event_id: 'evt-no-breadcrumbs',
      environment: 'production',
      exception: { values: [{ type: 'Error', value: 'boom' }] },
    }

    const result = await upsertIssueAndEvent(db, {
      projectId,
      environmentId,
      releaseId: null,
      fingerprint: 'fp-no-breadcrumbs',
      event,
    })

    const stored = await db.selectFrom('event').selectAll().where('id', '=', result.eventId).executeTakeFirstOrThrow()
    expect(stored.breadcrumbs).toBeNull()
  })
})
