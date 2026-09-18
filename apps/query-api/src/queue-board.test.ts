import Redis from 'ioredis'
import { describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import { registerQueueBoard } from './queue-board'

describe('registerQueueBoard', () => {
  it('mounts a route under /admin/queues', async () => {
    const app = Fastify()
    const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
      maxRetriesPerRequest: null,
      lazyConnect: true,
    })
    registerQueueBoard(app, connection)

    const response = await app.inject({ method: 'GET', url: '/admin/queues' })
    expect(response.statusCode).not.toBe(404)

    connection.disconnect()
    await app.close()
  })
})
