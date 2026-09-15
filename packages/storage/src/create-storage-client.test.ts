import { describe, expect, it } from 'vitest'
import { createStorageClient } from './create-storage-client'

const client = createStorageClient({
  endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
  region: 'us-east-1',
  accessKeyId: process.env.S3_ACCESS_KEY ?? 'flare',
  secretAccessKey: process.env.S3_SECRET_KEY ?? 'flare12345',
  bucket: process.env.S3_BUCKET ?? 'flare-source-maps',
})

describe('createStorageClient', () => {
  it('round-trips a small object through put and get', async () => {
    const key = `test/${Date.now()}.txt`
    await client.putObject(key, Buffer.from('hello flare'), 'text/plain')

    const result = await client.getObject(key)
    expect(result.toString('utf8')).toBe('hello flare')
  })
})
