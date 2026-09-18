import type { FastifyInstance } from 'fastify'

export function registerTraceRoutes(app: FastifyInstance): void {
  app.get<{ Params: { traceId: string } }>('/api/v1/traces/:traceId', async (request) => {
    const { db } = app.deps
    const transactions = await db
      .selectFrom('transaction')
      .selectAll()
      .where('trace_id', '=', request.params.traceId)
      .orderBy('start_ts', 'asc')
      .execute()

    const spans = await db
      .selectFrom('span')
      .selectAll()
      .where('trace_id', '=', request.params.traceId)
      .orderBy('start_ts', 'asc')
      .execute()

    return { transactions, spans }
  })
}
