import type { FastifyInstance } from 'fastify'
import { detectFlowDeviations } from '@flare/db'

export function registerFlowRoutes(app: FastifyInstance): void {
  app.get<{ Params: { flowTraceId: string } }>('/api/v1/flows/:flowTraceId', async (request, reply) => {
    const { db } = app.deps

    const trace = await db
      .selectFrom('flow_trace')
      .selectAll()
      .where('id', '=', request.params.flowTraceId)
      .executeTakeFirst()

    if (!trace) return reply.code(404).send({ error: 'not found' })

    const steps = await db
      .selectFrom('flow_step')
      .selectAll()
      .where('flow_trace_id', '=', request.params.flowTraceId)
      .orderBy('occurred_at', 'asc')
      .execute()

    const deviations = await detectFlowDeviations(db, request.params.flowTraceId)

    return { trace, steps, deviations }
  })
}
