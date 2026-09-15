import Fastify, { type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import type { Kysely } from 'kysely'
import type { Database } from '@flare/db'
import { registerIssueRoutes } from './routes/issues'

export interface AppDeps {
  db: Kysely<Database>
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps
  }
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: true })
  app.decorate('deps', deps)
  app.register(cors, { origin: true })

  app.get('/healthz', async () => ({ status: 'ok' }))
  registerIssueRoutes(app)

  return app
}
