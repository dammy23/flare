import Fastify, { type FastifyInstance } from 'fastify'
import multipart from '@fastify/multipart'
import type { Kysely } from 'kysely'
import type { Database } from '@flare/db'
import type { Redis } from 'ioredis'
import type { StorageClient } from '@flare/storage'
import type { EventProducer } from './kafka/producer'
import { registerEnvelopeRoute } from './routes/envelope'
import { registerReleaseRoutes } from './routes/releases'

export interface AppDeps {
  db: Kysely<Database>
  redis: Redis
  producer: EventProducer
  storage: StorageClient
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps
  }
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: true })
  app.decorate('deps', deps)

  app.register(multipart)

  app.addContentTypeParser(
    'application/x-sentry-envelope',
    { parseAs: 'buffer' },
    (_req, body, done) => done(null, body)
  )
  // The wildcard buffer parser below overrides Fastify's built-in JSON
  // parser for any content-type without its own registration, so
  // application/json needs its own explicit parser to keep working.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    try {
      done(null, JSON.parse(body as string))
    } catch (error) {
      done(error as Error, undefined)
    }
  })
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body))

  app.get('/healthz', async () => ({ status: 'ok' }))
  registerEnvelopeRoute(app)
  registerReleaseRoutes(app)

  return app
}
