import type { FastifyInstance } from 'fastify'
import type { Dashboard, WidgetType, WidgetEnvironmentMode, WidgetLayout } from '@flare/shared-types'

export function registerDashboardRoutes(app: FastifyInstance): void {
  app.get<{ Params: { projectId: string } }>(
    '/api/v1/projects/:projectId/dashboard',
    async (request, reply) => {
      const dashboard = await app.deps.db
        .selectFrom('dashboard')
        .selectAll()
        .where('project_id', '=', request.params.projectId)
        .executeTakeFirst()

      if (!dashboard) return reply.code(404).send({ error: 'not found' })

      const widgets = await app.deps.db
        .selectFrom('dashboard_widget')
        .selectAll()
        .where('dashboard_id', '=', dashboard.id)
        .execute()

      const body: Dashboard = {
        id: dashboard.id,
        projectId: dashboard.project_id,
        name: dashboard.name,
        envSelectorDefault: dashboard.env_selector_default,
        widgets: widgets.map((widget) => ({
          id: widget.id,
          widgetType: widget.widget_type as WidgetType,
          title: widget.title,
          layout: widget.layout as WidgetLayout,
          config: widget.config,
          environmentMode: widget.environment_mode as WidgetEnvironmentMode,
          pinnedEnvironmentName: widget.pinned_environment_name,
        })),
      }
      return body
    }
  )
}
