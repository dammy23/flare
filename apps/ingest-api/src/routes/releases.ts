import type { FastifyInstance } from 'fastify'
import { resolveProjectByPublicKey } from '../auth/resolve-project'
import { createRelease } from '../releases/create-release'
import { uploadArtifact } from '../releases/upload-artifact'

function bearerPublicKey(authHeader: string | undefined): string | null {
  if (!authHeader?.startsWith('Bearer ')) return null
  return authHeader.slice('Bearer '.length)
}

export function registerReleaseRoutes(app: FastifyInstance): void {
  app.post<{ Params: { org: string }; Body: { version: string } }>(
    '/api/0/organizations/:org/releases/',
    async (request, reply) => {
      const { db, redis } = app.deps
      const publicKey = bearerPublicKey(request.headers.authorization)
      if (!publicKey) return reply.code(401).send({ error: 'missing bearer token' })

      const project = await resolveProjectByPublicKey(publicKey, { db, redis })
      if (!project) return reply.code(401).send({ error: 'unknown project' })

      const result = await createRelease(db, redis, project.id, request.body.version)
      return reply.code(201).send(result)
    }
  )

  app.post<{ Params: { org: string; version: string } }>(
    '/api/0/organizations/:org/releases/:version/files/',
    async (request, reply) => {
      const { db, redis, storage } = app.deps
      const publicKey = bearerPublicKey(request.headers.authorization)
      if (!publicKey) return reply.code(401).send({ error: 'missing bearer token' })

      const project = await resolveProjectByPublicKey(publicKey, { db, redis })
      if (!project) return reply.code(401).send({ error: 'unknown project' })

      const parts = request.parts()
      let fileName = ''
      let content: Buffer | null = null
      let contentType: string | undefined

      for await (const part of parts) {
        if (part.type === 'field' && part.fieldname === 'name') {
          fileName = String(part.value)
        } else if (part.type === 'file' && part.fieldname === 'file') {
          content = await part.toBuffer()
          contentType = part.mimetype
          if (!fileName) fileName = part.filename
        }
      }

      if (!content || !fileName) return reply.code(400).send({ error: 'missing file or name' })

      const result = await uploadArtifact(
        { db, redis, storage },
        { projectId: project.id, version: request.params.version, fileName, content, contentType }
      )
      return reply.code(201).send({ storageKey: result.storageKey })
    }
  )
}
