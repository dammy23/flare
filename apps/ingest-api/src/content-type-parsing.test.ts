import { describe, expect, it } from 'vitest'
import { buildApp } from './app'

describe('content-type parsing', () => {
  it('parses application/json bodies as objects despite the wildcard buffer parser', async () => {
    const app = buildApp({ db: {} as never, redis: {} as never, producer: {} as never, storage: {} as never })
    app.post('/echo-body', async (request) => request.body)

    const response = await app.inject({
      method: 'POST',
      url: '/echo-body',
      payload: { hello: 'world' },
    })

    expect(response.json()).toEqual({ hello: 'world' })
  })

  it('still delivers unregistered content types as a raw buffer (the envelope path)', async () => {
    const app = buildApp({ db: {} as never, redis: {} as never, producer: {} as never, storage: {} as never })
    app.post('/echo-buffer', async (request) => {
      const body = request.body as Buffer
      return { isBuffer: Buffer.isBuffer(body), text: body.toString('utf8') }
    })

    const response = await app.inject({
      method: 'POST',
      url: '/echo-buffer',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from('raw bytes'),
    })

    expect(response.json()).toEqual({ isBuffer: true, text: 'raw bytes' })
  })
})
