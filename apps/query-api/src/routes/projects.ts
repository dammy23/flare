import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { provisionDefaultDashboard } from '@flare/db'

export function registerProjectRoutes(app: FastifyInstance): void {
  app.post<{ Body: { name: string; slug: string } }>('/api/v1/projects', async (request, reply) => {
    const { db } = app.deps
    const publicKey = randomBytes(16).toString('hex')

    let project
    try {
      project = await db
        .insertInto('project')
        .values({ name: request.body.name, slug: request.body.slug, public_key: publicKey })
        .returningAll()
        .executeTakeFirstOrThrow()
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        return reply.code(409).send({ error: 'slug or public key already exists' })
      }
      throw error
    }

    const dashboardId = await provisionDefaultDashboard(db, project.id)

    return reply.code(201).send({
      id: project.id,
      name: project.name,
      slug: project.slug,
      publicKey: project.public_key,
      dashboardId,
    })
  })
}
