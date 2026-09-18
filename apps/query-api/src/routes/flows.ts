import type { FastifyInstance } from 'fastify'
import { sql } from 'kysely'
import { detectFlowDeviations } from '@flare/db'

export function registerFlowRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { projectId: string } }>('/api/v1/flows/board', async (request) => {
    const { db } = app.deps

    const traces = await db
      .selectFrom('flow_trace')
      .select(['id', 'current_stage', 'status', 'last_activity_at'])
      .where('project_id', '=', request.query.projectId)
      .where('status', 'in', ['in_progress', 'stalled'])
      .orderBy('last_activity_at', 'desc')
      .execute()

    const byStage = new Map<string, typeof traces>()
    for (const trace of traces) {
      const key = trace.current_stage ?? '(none)'
      if (!byStage.has(key)) byStage.set(key, [])
      byStage.get(key)?.push(trace)
    }

    return Array.from(byStage.entries()).map(([stage, stageTraces]) => ({
      stage,
      traces: stageTraces.map((t) => ({ id: t.id, status: t.status, lastActivityAt: t.last_activity_at })),
    }))
  })

  app.get<{ Querystring: { projectId: string } }>('/api/v1/flows/map', async (request) => {
    const { db } = app.deps

    const result = await sql<{ from_stage: string; to_stage: string; count: string; avg_duration_ms: number | null }>`
      WITH ordered AS (
        SELECT fs.flow_trace_id, fs.stage_name, fs.occurred_at,
               LAG(fs.stage_name) OVER (PARTITION BY fs.flow_trace_id ORDER BY fs.occurred_at) AS prev_stage,
               LAG(fs.occurred_at) OVER (PARTITION BY fs.flow_trace_id ORDER BY fs.occurred_at) AS prev_occurred_at
        FROM flow_step fs
        JOIN flow_trace ft ON ft.id = fs.flow_trace_id
        WHERE ft.project_id = ${request.query.projectId}
      )
      SELECT prev_stage AS from_stage, stage_name AS to_stage,
             count(*) AS count,
             avg(extract(epoch from (occurred_at - prev_occurred_at)) * 1000) AS avg_duration_ms
      FROM ordered
      WHERE prev_stage IS NOT NULL
      GROUP BY prev_stage, stage_name
    `.execute(db)

    return result.rows.map((row) => ({
      from: row.from_stage,
      to: row.to_stage,
      count: Number(row.count),
      avgDurationMs: row.avg_duration_ms !== null ? Number(row.avg_duration_ms) : null,
    }))
  })

  app.get<{ Params: { flowTraceId: string }; Querystring: { projectId?: string } }>(
    '/api/v1/flows/:flowTraceId',
    async (request, reply) => {
      const { db } = app.deps

      if (!request.query.projectId) return reply.code(404).send({ error: 'not found' })

      const trace = await db
        .selectFrom('flow_trace')
        .selectAll()
        .where('id', '=', request.params.flowTraceId)
        .where('project_id', '=', request.query.projectId)
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
    }
  )
}
