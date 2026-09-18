import type { FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { FlowCheckpointSchema } from '@flare/shared-types'
import { resolveProjectByPublicKey } from '../auth/resolve-project'

const RETRY_OPTS = { attempts: 5, backoff: { type: 'exponential' as const, delay: 1000 } }

function bearerPublicKey(authHeader: string | undefined): string | null {
  if (!authHeader?.startsWith('Bearer ')) return null
  return authHeader.slice('Bearer '.length)
}

export function registerFlowCheckpointRoute(app: FastifyInstance): void {
  app.post('/api/v1/flows/checkpoints', async (request, reply) => {
    const { db, redis, producer } = app.deps

    const publicKey = bearerPublicKey(request.headers.authorization)
    if (!publicKey) return reply.code(401).send({ error: 'missing bearer token' })

    const project = await resolveProjectByPublicKey(publicKey, { db, redis })
    if (!project) return reply.code(401).send({ error: 'unknown project' })

    let checkpoint
    try {
      checkpoint = FlowCheckpointSchema.parse(request.body)
    } catch (error) {
      if (error instanceof ZodError) return reply.code(400).send({ error: 'invalid checkpoint', details: error.issues })
      throw error
    }

    await producer.send('ingest.flow', 'checkpoint', { projectId: project.id, checkpoint }, RETRY_OPTS)

    return reply.code(202).send({ status: 'accepted' })
  })
}
