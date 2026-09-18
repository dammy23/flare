import Fastify, { type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import cookie from '@fastify/cookie'
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
import { registerAuthRoutes } from './routes/auth'
import { registerQueueBoard } from './queue-board'
import { getCurrentUser, type CurrentUser } from './auth/current-user'

export interface AppDeps {
  db: Kysely<Database>
  redis: Redis
  storage: StorageClient
  queueConnection: Redis
  cookieSecret: string
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps
  }
  interface FastifyRequest {
    currentUser: CurrentUser | null
  }
}

// Paths reachable without a session. Everything else -- including
// /api/v1/auth/logout and /api/v1/me -- goes through the auth gate below;
// logging out or fetching "me" without a session simply 401s, which is
// fine since the frontend never calls them in that state.
const PUBLIC_PATHS = new Set(['/healthz', '/api/v1/auth/register', '/api/v1/auth/login'])

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: true })
  app.decorate('deps', deps)
  app.decorateRequest('currentUser', null)
  app.register(cors, { origin: true, credentials: true })
  app.register(cookie, { secret: deps.cookieSecret })

  app.addHook('onRequest', async (request, reply) => {
    if (PUBLIC_PATHS.has(request.url.split('?')[0])) return

    const user = await getCurrentUser(request, deps.redis)
    request.currentUser = user
    if (!user) return reply.code(401).send({ error: 'unauthorized' })

    if (request.url.startsWith('/admin/queues') && !user.isAdmin) {
      return reply.code(403).send({ error: 'forbidden' })
    }
  })

  app.get('/healthz', async () => ({ status: 'ok' }))
  registerAuthRoutes(app)
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
