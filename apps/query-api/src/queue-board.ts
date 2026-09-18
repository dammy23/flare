import { createBullBoard } from '@bull-board/api'
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter'
import { FastifyAdapter } from '@bull-board/fastify'
import { Queue } from 'bullmq'
import type { FastifyInstance } from 'fastify'
import type { Redis } from 'ioredis'

const QUEUE_NAMES = ['ingest.errors', 'ingest.transactions', 'ingest.replays', 'work.symbolication']

export function registerQueueBoard(app: FastifyInstance, connection: Redis): void {
  const serverAdapter = new FastifyAdapter()
  serverAdapter.setBasePath('/admin/queues')

  createBullBoard({
    // @bull-board/api@5.23's bundled types predate bullmq's `Job.progress`
    // widening to include `string`, so BullMQAdapter's structural type no
    // longer matches its own `queues` param exactly. Harmless at runtime
    // (this is a type-only mismatch); a bull-board major upgrade would fix
    // it but also forces a Fastify v5 upgrade across this app, which is out
    // of scope here.
    queues: QUEUE_NAMES.map((name) => new BullMQAdapter(new Queue(name, { connection }))) as Parameters<
      typeof createBullBoard
    >[0]['queues'],
    serverAdapter,
  })

  app.register(serverAdapter.registerPlugin(), { basePath: '/admin/queues', prefix: '/admin/queues' })
}
