import { createDb } from '@flare/db'
import { SentryEventItemSchema, TransactionItemSchema } from '@flare/shared-types'
import Redis from 'ioredis'
import { parseEnvelope } from '../envelope/parse-envelope'
import { createQueueProducer } from '../queue/producer'

interface Args {
  projectId: string
  from: string
  to: string
}

function parseArgs(): Args {
  const args = process.argv.slice(2)
  const get = (flag: string) => {
    const i = args.indexOf(flag)
    if (i === -1 || !args[i + 1]) throw new Error(`missing ${flag}`)
    return args[i + 1]
  }
  return { projectId: get('--project'), from: get('--from'), to: get('--to') }
}

async function main(): Promise<void> {
  const { projectId, from, to } = parseArgs()
  const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')
  const queueConnection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null })
  const producer = createQueueProducer(queueConnection)

  const rows = await db
    .selectFrom('raw_envelope')
    .selectAll()
    .where('project_id', '=', projectId)
    .where('received_at', '>=', new Date(from))
    .where('received_at', '<', new Date(to))
    .execute()

  console.log(`replaying ${rows.length} archived envelopes for project ${projectId}`)

  for (const row of rows) {
    const envelope = parseEnvelope(Buffer.from(row.raw_bytes))
    for (const item of envelope.items) {
      if (item.header.type === 'event') {
        const parsed = SentryEventItemSchema.parse(JSON.parse(item.payload.toString('utf8')))
        await producer.send(
          'ingest.errors',
          'error',
          { projectId, event: parsed },
          { jobId: `${projectId}:${parsed.event_id}:replay` }
        )
      } else if (item.header.type === 'transaction') {
        const parsed = TransactionItemSchema.parse(JSON.parse(item.payload.toString('utf8')))
        await producer.send(
          'ingest.transactions',
          'transaction',
          { projectId, event: parsed },
          { jobId: `${projectId}:${parsed.event_id}:replay` }
        )
      } else if (item.header.type === 'replay_event' || item.header.type === 'replay_recording') {
        await producer.send('ingest.replays', 'replay', {
          projectId,
          itemType: item.header.type,
          payload: item.payload.toString('base64'),
        })
      }
    }
  }

  await producer.close()
  await queueConnection.quit()
  await db.destroy()
  console.log('done')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
