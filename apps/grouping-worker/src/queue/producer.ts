import { Queue, type JobsOptions } from 'bullmq'
import type { Redis } from 'ioredis'

export interface QueueProducer {
  send(queueName: string, jobName: string, data: unknown, opts?: JobsOptions): Promise<void>
  close(): Promise<void>
}

export function createQueueProducer(connection: Redis): QueueProducer {
  const queues = new Map<string, Queue>()

  function getQueue(name: string): Queue {
    let queue = queues.get(name)
    if (!queue) {
      queue = new Queue(name, { connection })
      queues.set(name, queue)
    }
    return queue
  }

  return {
    send: async (queueName, jobName, data, opts) => {
      await getQueue(queueName).add(jobName, data, opts)
    },
    close: async () => {
      await Promise.all([...queues.values()].map((queue) => queue.close()))
    },
  }
}
