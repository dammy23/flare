import { Queue } from 'bullmq'
import Redis from 'ioredis'
import { afterAll, describe, expect, it } from 'vitest'
import { startConsumer } from './consumer'

const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null })

afterAll(() => connection.disconnect())

describe('startConsumer', () => {
  it('invokes onMessage for each job added to the queue', async () => {
    const queueName = `grouping-worker-test-${Date.now()}`
    const queue = new Queue(queueName, { connection })

    const received: unknown[] = []
    const worker = startConsumer(connection, queueName, async (data) => {
      received.push(data)
    })

    await queue.add('hello', { message: 'hello-from-test' })

    await new Promise((resolve) => setTimeout(resolve, 2000))

    expect(received).toContainEqual({ message: 'hello-from-test' })

    await worker.close()
    await queue.close()
  })
})
