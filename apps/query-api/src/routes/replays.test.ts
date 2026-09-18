import { createDb } from '@flare/db'
import { createStorageClient } from '@flare/storage'
import Redis from 'ioredis'
import { afterAll, describe, expect, it } from 'vitest'
import { buildApp } from '../app'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379')
const storage = createStorageClient({
  endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
  region: 'us-east-1',
  accessKeyId: process.env.S3_ACCESS_KEY ?? 'flare',
  secretAccessKey: process.env.S3_SECRET_KEY ?? 'flare12345',
  bucket: process.env.S3_BUCKET ?? 'flare-source-maps',
})
const queueConnection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
  lazyConnect: true,
})
const app = buildApp({ db, redis, storage, queueConnection })

afterAll(async () => {
  await db.destroy()
  redis.disconnect()
  queueConnection.disconnect()
  await app.close()
})

describe('replays', () => {
  it('lists replays for a project and returns one with presigned segment URLs', async () => {
    const project = await db
      .insertInto('project')
      .values({ name: 'Replay Route Test', slug: `replay-route-${Date.now()}`, public_key: `pk-replay-route-${Date.now()}` })
      .returningAll()
      .executeTakeFirstOrThrow()
    const environment = await db
      .insertInto('environment')
      .values({ project_id: project.id, name: 'production' })
      .returningAll()
      .executeTakeFirstOrThrow()
    const replay = await db
      .insertInto('replay')
      .values({ project_id: project.id, environment_id: environment.id, session_id: `sess-${Date.now()}` })
      .returningAll()
      .executeTakeFirstOrThrow()
    await db
      .insertInto('replay_segment')
      .values({ replay_id: replay.id, sequence: 0, storage_key: `replays/${project.id}/${replay.id}/0.bin`, size_bytes: 10 })
      .execute()

    const listResponse = await app.inject({ method: 'GET', url: `/api/v1/projects/${project.id}/replays` })
    expect(listResponse.statusCode).toBe(200)
    expect(listResponse.json().some((r: { id: string }) => r.id === replay.id)).toBe(true)

    const detailResponse = await app.inject({ method: 'GET', url: `/api/v1/replays/${replay.id}?projectId=${project.id}` })
    expect(detailResponse.statusCode).toBe(200)
    const body = detailResponse.json()
    expect(body.segments).toHaveLength(1)
    expect(body.segments[0].downloadUrl).toContain('0.bin')

    const otherProject = await db
      .insertInto('project')
      .values({ name: 'Other Replay Project', slug: `other-replay-${Date.now()}`, public_key: `pk-other-replay-${Date.now()}` })
      .returningAll()
      .executeTakeFirstOrThrow()
    const crossProjectResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/replays/${replay.id}?projectId=${otherProject.id}`,
    })
    expect(crossProjectResponse.statusCode).toBe(404)
  })

  it('returns 404 for an unknown replay', async () => {
    const project = await db
      .insertInto('project')
      .values({ name: 'Unknown Replay Test', slug: `unknown-replay-${Date.now()}`, public_key: `pk-unknown-replay-${Date.now()}` })
      .returningAll()
      .executeTakeFirstOrThrow()
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/replays/00000000-0000-0000-0000-000000000000?projectId=${project.id}`,
    })
    expect(response.statusCode).toBe(404)
  })

  it('returns 404 when projectId is missing entirely', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/replays/00000000-0000-0000-0000-000000000000' })
    expect(response.statusCode).toBe(404)
  })
})
