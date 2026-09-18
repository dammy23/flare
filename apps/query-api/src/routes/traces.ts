import type { FastifyInstance } from 'fastify'

export function registerTraceRoutes(app: FastifyInstance): void {
  app.get<{ Params: { traceId: string }; Querystring: { projectId?: string } }>(
    '/api/v1/traces/:traceId',
    async (request) => {
      const { db } = app.deps

      if (!request.query.projectId) return { transactions: [], spans: [] }

      const transactions = await db
        .selectFrom('transaction')
        .selectAll()
        .where('trace_id', '=', request.params.traceId)
        .where('project_id', '=', request.query.projectId)
        .orderBy('start_ts', 'asc')
        .execute()

      const spans = await db
        .selectFrom('span')
        .innerJoin('transaction', 'transaction.id', 'span.transaction_id')
        .selectAll('span')
        .where('span.trace_id', '=', request.params.traceId)
        .where('transaction.project_id', '=', request.query.projectId)
        .orderBy('span.start_ts', 'asc')
        .execute()

      return { transactions, spans }
    }
  )
}
