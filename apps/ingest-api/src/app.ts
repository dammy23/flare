import Fastify, { type FastifyInstance } from 'fastify'
import type { Kysely } from 'kysely'
import type { Database } from '@flare/db'
import type { Redis } from 'ioredis'
import type { EventProducer } from './kafka/producer'
import { registerEnvelopeRoute } from './routes/envelope'

export interface AppDeps {
  db: Kysely<Database>
  redis: Redis
  producer: EventProducer
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps
  }
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: true })
  app.decorate('deps', deps)

  app.addContentTypeParser(
    'application/x-sentry-envelope',
    { parseAs: 'buffer' },
    (_req, body, done) => done(null, body)
  )
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body))

  app.get('/healthz', async () => ({ status: 'ok' }))
  registerEnvelopeRoute(app)

  return app
}
