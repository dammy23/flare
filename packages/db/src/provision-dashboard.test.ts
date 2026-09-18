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
      ['events_by_environment', 'issues_over_time', 'new_issues', 'top_issues', 'transaction_latency', 'replay_count'].sort()
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
