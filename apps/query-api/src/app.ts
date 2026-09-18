import Fastify, { type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import type { Kysely } from 'kysely'
import type { Database } from '@flare/db'
import type { Redis } from 'ioredis'
import type { StorageClient } from '@flare/storage'
import { registerIssueRoutes } from './routes/issues'
import { registerProjectRoutes } from './routes/projects'
import { registerDashboardRoutes } from './routes/dashboard'
import { registerWidgetRoutes } from './routes/widgets'
import { registerWidgetDataRoute } from './routes/widget-data'
import { registerTraceRoutes } from './routes/traces'
import { registerReplayRoutes } from './routes/replays'
import { registerFlowRoutes } from './routes/flows'
import { registerQueueBoard } from './queue-board'

export interface AppDeps {
  db: Kysely<Database>
  redis: Redis
  storage: StorageClient
  queueConnection: Redis
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
  registerProjectRoutes(app)
  registerDashboardRoutes(app)
  registerWidgetRoutes(app)
  registerWidgetDataRoute(app)
  registerTraceRoutes(app)
  registerReplayRoutes(app)
  registerFlowRoutes(app)
  registerQueueBoard(app, deps.queueConnection)

  return app
}
