import type { FastifyInstance } from 'fastify'
import { archiveRawEnvelope } from '@flare/db'
import { SentryEventItemSchema, TransactionItemSchema } from '@flare/shared-types'
import { parseSentryAuthHeader } from '../auth/parse-sentry-auth-header'
import { resolveProjectByPublicKey } from '../auth/resolve-project'
import { checkRateLimit } from '../rate-limit/check-rate-limit'
import { parseEnvelope } from '../envelope/parse-envelope'

const RETRY_OPTS = { attempts: 5, backoff: { type: 'exponential' as const, delay: 1000 } }

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

    // Durable archive of the wire bytes, before any queue interaction --
    // this is what makes reprocessing possible later regardless of what
    // happens downstream. Deliberately unguarded: if this throws (e.g.
    // Postgres unreachable), the request fails with a 500 rather than
    // silently proceeding without the durability guarantee this exists
    // for.
    await archiveRawEnvelope(db, {
      projectId: project.id,
      eventId: envelope.header.event_id ?? null,
      rawBytes: raw,
    })

    let lastEventId: string | undefined
    for (const item of envelope.items) {
      if (item.header.type === 'event') {
        const parsed = SentryEventItemSchema.parse(JSON.parse(item.payload.toString('utf8')))
        lastEventId = parsed.event_id
        await producer.send(
          'ingest.errors',
          'error',
          { projectId: project.id, event: parsed },
          { jobId: `${project.id}:${parsed.event_id}`, ...RETRY_OPTS }
        )
      } else if (item.header.type === 'transaction') {
        const parsed = TransactionItemSchema.parse(JSON.parse(item.payload.toString('utf8')))
        lastEventId = parsed.event_id
        await producer.send(
          'ingest.transactions',
          'transaction',
          { projectId: project.id, event: parsed },
          { jobId: `${project.id}:${parsed.event_id}`, ...RETRY_OPTS }
        )
      } else if (item.header.type === 'replay_event' || item.header.type === 'replay_recording') {
        await producer.send(
          'ingest.replays',
          'replay',
          { projectId: project.id, itemType: item.header.type, payload: item.payload.toString('base64') },
          RETRY_OPTS
        )
      }
    }

    return reply.code(200).send({ id: lastEventId ?? envelope.header.event_id })
  })
}
