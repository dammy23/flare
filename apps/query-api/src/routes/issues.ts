import type { FastifyInstance } from 'fastify'
import type { IssueDetail, IssueSummary } from '@flare/shared-types'

export function registerIssueRoutes(app: FastifyInstance): void {
  app.get<{ Params: { projectId: string } }>(
    '/api/v1/projects/:projectId/issues',
    async (request) => {
      const rows = await app.deps.db
        .selectFrom('issue')
        .selectAll()
        .where('project_id', '=', request.params.projectId)
        .orderBy('last_seen', 'desc')
        .execute()

      const summaries: IssueSummary[] = rows.map((row) => ({
        id: row.id,
        title: row.title,
        culprit: row.culprit,
        status: row.status,
        timesSeen: row.times_seen,
        firstSeen: row.first_seen.toISOString(),
        lastSeen: row.last_seen.toISOString(),
      }))
      return summaries
    }
  )

  app.get<{ Params: { issueId: string }; Querystring: { projectId?: string } }>(
    '/api/v1/issues/:issueId',
    async (request, reply) => {
      if (!request.query.projectId) return reply.code(404).send({ error: 'not found' })

      const issue = await app.deps.db
        .selectFrom('issue')
        .selectAll()
        .where('id', '=', request.params.issueId)
        .where('project_id', '=', request.query.projectId)
        .executeTakeFirst()

      if (!issue) return reply.code(404).send({ error: 'not found' })

      const events = await app.deps.db
        .selectFrom('event')
        .selectAll()
        .where('issue_id', '=', issue.id)
        .orderBy('timestamp', 'desc')
        .limit(50)
        .execute()

      const detail: IssueDetail = {
        id: issue.id,
        title: issue.title,
        culprit: issue.culprit,
        status: issue.status,
        timesSeen: issue.times_seen,
        firstSeen: issue.first_seen.toISOString(),
        lastSeen: issue.last_seen.toISOString(),
        events: events.map((event) => ({
          id: event.id,
          timestamp: event.timestamp.toISOString(),
          message: event.message,
          exception: event.exception,
        })),
      }
      return detail
    }
  )
}
