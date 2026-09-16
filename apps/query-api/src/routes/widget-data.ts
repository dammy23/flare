import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { WidgetTypeSchema } from '@flare/shared-types'
import { runWidgetQuery } from '../widgets/run-widget-query'

const CACHE_TTL_SECONDS = 30

export function registerWidgetDataRoute(app: FastifyInstance): void {
  app.get<{ Params: { id: string }; Querystring: { environment?: string } }>(
    '/api/v1/widgets/:id/data',
    async (request, reply) => {
      const { db, redis } = app.deps
      const widget = await db
        .selectFrom('dashboard_widget')
        .innerJoin('dashboard', 'dashboard.id', 'dashboard_widget.dashboard_id')
        .select([
          'dashboard_widget.widget_type',
          'dashboard_widget.config',
          'dashboard_widget.environment_mode',
          'dashboard_widget.pinned_environment_name',
          'dashboard.project_id',
          'dashboard.env_selector_default',
        ])
        .where('dashboard_widget.id', '=', request.params.id)
        .executeTakeFirst()

      if (!widget) return reply.code(404).send({ error: 'not found' })

      const environmentName =
        widget.environment_mode === 'pin'
          ? widget.pinned_environment_name
          : request.query.environment ?? widget.env_selector_default ?? null

      const configHash = createHash('sha1').update(JSON.stringify(widget.config)).digest('hex')
      const cacheKey = `widgetdata:${widget.widget_type}:${configHash}:${environmentName ?? 'all'}`

      const cached = await redis.get(cacheKey)
      if (cached) return reply.send({ data: JSON.parse(cached) })

      const data = await runWidgetQuery(db, WidgetTypeSchema.parse(widget.widget_type), widget.config, {
        projectId: widget.project_id,
        environmentName,
      })

      await redis.set(cacheKey, JSON.stringify(data), 'EX', CACHE_TTL_SECONDS)
      return reply.send({ data })
    }
  )
}
