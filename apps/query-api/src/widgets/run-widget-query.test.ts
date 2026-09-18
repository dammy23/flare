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

  it('transaction_latency returns rollup rows for the configured transaction name', async () => {
    const { project, environment } = await seedProjectWithData()
    await db
      .insertInto('transaction_latency_rollup')
      .values({
        project_id: project.id,
        environment_id: environment.id,
        transaction_name: 'GET /api/rollup-widget-test',
        hour_bucket: new Date(),
        p50_ms: 100,
        p95_ms: 200,
        p99_ms: 300,
        count: 5,
      })
      .execute()

    const result = (await runWidgetQuery(
      db,
      'transaction_latency',
      { transactionName: 'GET /api/rollup-widget-test', hours: 24 },
      { projectId: project.id, environmentName: null }
    )) as Array<{ p50_ms: number }>
    expect(result).toHaveLength(1)
    expect(result[0].p50_ms).toBe(100)
  })

  it('transaction_latency returns an empty array for an unconfigured widget (empty transactionName)', async () => {
    const { project } = await seedProjectWithData()
    const result = await runWidgetQuery(db, 'transaction_latency', {}, { projectId: project.id, environmentName: null })
    expect(result).toEqual([])
  })

  it('replay_count returns the count of replays in the window', async () => {
    const { project, environment } = await seedProjectWithData()
    await db
      .insertInto('replay')
      .values({ project_id: project.id, environment_id: environment.id, session_id: `sess-widget-${Date.now()}` })
      .execute()

    const result = (await runWidgetQuery(
      db,
      'replay_count',
      { windowDays: 14 },
      { projectId: project.id, environmentName: null }
    )) as { count: number }
    expect(Number(result.count)).toBeGreaterThan(0)
  })
})
