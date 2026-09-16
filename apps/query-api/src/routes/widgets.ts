import type { FastifyInstance } from 'fastify'
import { WidgetLayoutSchema, WidgetTypeSchema, validateWidgetConfig } from '@flare/shared-types'

export function registerWidgetRoutes(app: FastifyInstance): void {
  app.post<{ Body: { dashboardId: string; widgetType: string; title: string; layout: unknown } }>(
    '/api/v1/widgets',
    async (request, reply) => {
      const widgetType = WidgetTypeSchema.parse(request.body.widgetType)
      const layout = WidgetLayoutSchema.parse(request.body.layout)

      const widget = await app.deps.db
        .insertInto('dashboard_widget')
        .values({
          dashboard_id: request.body.dashboardId,
          widget_type: widgetType,
          title: request.body.title,
          layout: JSON.stringify(layout),
          config: '{}',
        })
        .returning('id')
        .executeTakeFirstOrThrow()

      return reply.code(201).send({ id: widget.id })
    }
  )

  app.delete<{ Params: { id: string } }>('/api/v1/widgets/:id', async (request, reply) => {
    await app.deps.db.deleteFrom('dashboard_widget').where('id', '=', request.params.id).execute()
    return reply.code(204).send()
  })

  app.patch<{ Params: { id: string }; Body: unknown }>('/api/v1/widgets/:id/layout', async (request, reply) => {
    const layout = WidgetLayoutSchema.parse(request.body)
    await app.deps.db
      .updateTable('dashboard_widget')
      .set({ layout: JSON.stringify(layout), layout_updated_at: new Date() })
      .where('id', '=', request.params.id)
      .execute()
    return reply.code(200).send({ ok: true })
  })

  app.patch<{ Params: { id: string }; Body: unknown }>('/api/v1/widgets/:id/config', async (request, reply) => {
    const widget = await app.deps.db
      .selectFrom('dashboard_widget')
      .select('widget_type')
      .where('id', '=', request.params.id)
      .executeTakeFirst()
    if (!widget) return reply.code(404).send({ error: 'not found' })

    let config: unknown
    try {
      config = validateWidgetConfig(WidgetTypeSchema.parse(widget.widget_type), request.body)
    } catch {
      return reply.code(400).send({ error: 'invalid config for this widget type' })
    }

    await app.deps.db
      .updateTable('dashboard_widget')
      .set({ config: JSON.stringify(config), config_updated_at: new Date() })
      .where('id', '=', request.params.id)
      .execute()
    return reply.code(200).send({ ok: true })
  })
}
