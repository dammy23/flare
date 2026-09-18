import type { FastifyInstance } from 'fastify'
import { listUsers, setUserAdmin } from '@flare/db'

export function registerUserRoutes(app: FastifyInstance): void {
  app.get('/api/v1/users', async (request, reply) => {
    if (!request.currentUser?.isAdmin) return reply.code(403).send({ error: 'forbidden' })

    return listUsers(app.deps.db)
  })

  app.patch<{ Params: { id: string }; Body: { isAdmin: boolean } }>(
    '/api/v1/users/:id',
    async (request, reply) => {
      if (!request.currentUser?.isAdmin) return reply.code(403).send({ error: 'forbidden' })

      // An admin can't demote themselves -- otherwise a lone admin could
      // lock themselves out of user management with no one left to
      // reverse it.
      if (request.params.id === request.currentUser.id && !request.body.isAdmin) {
        return reply.code(400).send({ error: 'cannot remove your own admin access' })
      }

      const updated = await setUserAdmin(app.deps.db, request.params.id, request.body.isAdmin)
      if (!updated) return reply.code(404).send({ error: 'not found' })

      return updated
    }
  )
}
