import { describe, expect, it } from 'vitest'
import { buildApp } from './app'

describe('buildApp', () => {
  it('responds 200 on GET /healthz', async () => {
    const app = buildApp({ db: {} as never, redis: {} as never, producer: {} as never, storage: {} as never })
    const response = await app.inject({ method: 'GET', url: '/healthz' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: 'ok' })
  })
})
