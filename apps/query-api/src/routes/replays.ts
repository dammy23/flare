import type { FastifyInstance } from 'fastify'

export function registerReplayRoutes(app: FastifyInstance): void {
  app.get<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/replays', async (request) => {
    return app.deps.db
      .selectFrom('replay')
      .selectAll()
      .where('project_id', '=', request.params.projectId)
      .orderBy('started_at', 'desc')
      .execute()
  })

  app.get<{ Params: { id: string }; Querystring: { projectId?: string } }>('/api/v1/replays/:id', async (request, reply) => {
    if (!request.query.projectId) return reply.code(404).send({ error: 'not found' })

    const replay = await app.deps.db
      .selectFrom('replay')
      .selectAll()
      .where('id', '=', request.params.id)
      .where('project_id', '=', request.query.projectId)
      .executeTakeFirst()
    if (!replay) return reply.code(404).send({ error: 'not found' })

    const segments = await app.deps.db
      .selectFrom('replay_segment')
      .selectAll()
      .where('replay_id', '=', replay.id)
      .orderBy('sequence', 'asc')
      .execute()

    const segmentsWithUrls = await Promise.all(
      segments.map(async (segment) => ({
        sequence: segment.sequence,
        sizeBytes: segment.size_bytes,
        downloadUrl: await app.deps.storage.getPresignedDownloadUrl(segment.storage_key),
      }))
    )

    return { ...replay, segments: segmentsWithUrls }
  })
}
