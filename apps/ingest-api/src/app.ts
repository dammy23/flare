import Fastify, { type FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import type { Database } from '@flare/db'
import type { Redis } from 'ioredis'

export interface AppDeps {
  db: Kysely<Database>
  redis: Redis
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps
  }
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: true })
  app.decorate('deps', deps)

  app.get('/healthz', async () => ({ status: 'ok' }))

  return app
}
