import type { Kysely } from 'kysely'
import type { Database } from './schema'

const STARTER_WIDGETS: Array<{ widget_type: string; title: string; layout: { x: number; y: number; w: number; h: number } }> = [
  { widget_type: 'issues_over_time', title: 'Issues Over Time', layout: { x: 0, y: 0, w: 6, h: 4 } },
  { widget_type: 'top_issues', title: 'Top Issues', layout: { x: 6, y: 0, w: 6, h: 4 } },
  { widget_type: 'new_issues', title: 'New Issues', layout: { x: 0, y: 4, w: 6, h: 4 } },
  { widget_type: 'events_by_environment', title: 'Events by Environment', layout: { x: 6, y: 4, w: 6, h: 4 } },
  { widget_type: 'transaction_latency', title: 'Transaction Latency', layout: { x: 0, y: 8, w: 12, h: 4 } },
  { widget_type: 'replay_count', title: 'Replay Count', layout: { x: 0, y: 12, w: 6, h: 4 } },
  { widget_type: 'flows_by_stage', title: 'Flows by Stage', layout: { x: 6, y: 12, w: 6, h: 4 } },
]

export async function provisionDefaultDashboard(db: Kysely<Database>, projectId: string): Promise<string> {
  return db.transaction().execute(async (trx) => {
    const existing = await trx
      .selectFrom('dashboard')
      .select('id')
      .where('project_id', '=', projectId)
      .executeTakeFirst()
    if (existing) return existing.id

    const dashboard = await trx
      .insertInto('dashboard')
      .values({ project_id: projectId })
      .returning('id')
      .executeTakeFirstOrThrow()

    await trx
      .insertInto('dashboard_widget')
      .values(
        STARTER_WIDGETS.map((widget) => ({
          dashboard_id: dashboard.id,
          widget_type: widget.widget_type,
          title: widget.title,
          layout: JSON.stringify(widget.layout),
          config: '{}',
        }))
      )
      .execute()

    return dashboard.id
  })
}
