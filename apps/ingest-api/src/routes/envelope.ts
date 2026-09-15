import type { FastifyInstance } from 'fastify'
import { SentryEventItemSchema } from '@flare/shared-types'
import { parseSentryAuthHeader } from '../auth/parse-sentry-auth-header'
import { resolveProjectByPublicKey } from '../auth/resolve-project'
import { checkRateLimit } from '../rate-limit/check-rate-limit'
import { parseEnvelope } from '../envelope/parse-envelope'

export function registerEnvelopeRoute(app: FastifyInstance): void {
  app.post<{ Params: { projectId: string } }>('/api/:projectId/envelope/', async (request, reply) => {
    const { db, redis, producer } = app.deps

    const authHeader = request.headers['x-sentry-auth']
    const publicKey =
      parseSentryAuthHeader(Array.isArray(authHeader) ? authHeader[0] : authHeader) ??
      (typeof (request.query as { sentry_key?: string })?.sentry_key === 'string'
        ? (request.query as { sentry_key: string }).sentry_key
        : null)

    if (!publicKey) {
      return reply.code(401).send({ error: 'missing sentry_key' })
    }

    const project = await resolveProjectByPublicKey(publicKey, { db, redis })
    if (!project || project.id !== request.params.projectId) {
      return reply.code(401).send({ error: 'unknown project' })
    }

    const rateLimit = await checkRateLimit(redis, project.id, 'error')
    if (!rateLimit.allowed) {
      return reply
        .code(429)
        .header('Retry-After', String(rateLimit.retryAfterSeconds))
        .header('X-Sentry-Rate-Limits', `${rateLimit.retryAfterSeconds}:error:key`)
        .send()
    }

    const raw = request.body as Buffer
    const envelope = parseEnvelope(raw)

    let lastEventId: string | undefined
    for (const item of envelope.items) {
      if (item.header.type !== 'event') continue
      const parsed = SentryEventItemSchema.parse(JSON.parse(item.payload.toString('utf8')))
      lastEventId = parsed.event_id
      await producer.send(
        'ingest.errors',
        `${project.id}:${parsed.event_id}`,
        JSON.stringify({ projectId: project.id, event: parsed })
      )
    }

    return reply.code(200).send({ id: lastEventId ?? envelope.header.event_id })
  })
}
