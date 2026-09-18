import { Worker, type Job } from 'bullmq'
import type { Redis } from 'ioredis'

export type MessageHandler = (data: unknown) => Promise<void>

export function startConsumer(
  connection: Redis,
  queueName: string,
  onMessage: MessageHandler,
  opts: { concurrency?: number } = {}
): Worker {
  const worker = new Worker(
    queueName,
    async (job: Job) => onMessage(job.data),
    { connection, concurrency: opts.concurrency ?? 5 }
  )
  worker.on('failed', (job, err) => {
    console.error(`[${queueName}] job ${job?.id} failed:`, err.message)
  })
  return worker
}
