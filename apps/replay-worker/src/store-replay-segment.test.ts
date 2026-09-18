import { createDb } from '@flare/db'
import { createStorageClient } from '@flare/storage'
import { afterAll, describe, expect, it } from 'vitest'
import { storeReplaySegment } from './store-replay-segment'
import { upsertReplayEvent } from './upsert-replay-event'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')
const storage = createStorageClient({
  endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
  region: 'us-east-1',
  accessKeyId: process.env.S3_ACCESS_KEY ?? 'flare',
  secretAccessKey: process.env.S3_SECRET_KEY ?? 'flare12345',
  bucket: process.env.S3_BUCKET ?? 'flare-source-maps',
})

afterAll(() => db.destroy())

describe('storeReplaySegment', () => {
  it('writes the segment blob to storage and records a replay_segment row, bumping segment_count', async () => {
    const project = await db
      .insertInto('project')
      .values({ name: 'Segment Test', slug: `segment-test-${Date.now()}`, public_key: `pk-segment-${Date.now()}` })
      .returningAll()
      .executeTakeFirstOrThrow()
    const environment = await db
      .insertInto('environment')
      .values({ project_id: project.id, name: 'production' })
      .returningAll()
      .executeTakeFirstOrThrow()
    const replayId = await upsertReplayEvent(db, {
      projectId: project.id,
      environmentId: environment.id,
      sessionId: `session-seg-${Date.now()}`,
      errorCount: 0,
    })

    await storeReplaySegment(
      { db, storage },
      { projectId: project.id, replayId, sequence: 0, content: Buffer.from('rrweb events blob') }
    )

    const segment = await db
      .selectFrom('replay_segment')
      .selectAll()
      .where('replay_id', '=', replayId)
      .where('sequence', '=', 0)
      .executeTakeFirstOrThrow()
    expect(segment.size_bytes).toBe(Buffer.byteLength('rrweb events blob'))

    const replay = await db.selectFrom('replay').selectAll().where('id', '=', replayId).executeTakeFirstOrThrow()
    expect(replay.segment_count).toBe(1)
  })

  it('does not double-count segment_count when the same segment is retried (Kafka at-least-once)', async () => {
    const project = await db
      .insertInto('project')
      .values({ name: 'Segment Retry Test', slug: `segment-retry-${Date.now()}`, public_key: `pk-segment-retry-${Date.now()}` })
      .returningAll()
      .executeTakeFirstOrThrow()
    const environment = await db
      .insertInto('environment')
      .values({ project_id: project.id, name: 'production' })
      .returningAll()
      .executeTakeFirstOrThrow()
    const replayId = await upsertReplayEvent(db, {
      projectId: project.id,
      environmentId: environment.id,
      sessionId: `session-retry-${Date.now()}`,
      errorCount: 0,
    })

    const args = { projectId: project.id, replayId, sequence: 0, content: Buffer.from('retry blob') }
    await storeReplaySegment({ db, storage }, args)
    await storeReplaySegment({ db, storage }, args)

    const segments = await db.selectFrom('replay_segment').selectAll().where('replay_id', '=', replayId).execute()
    expect(segments).toHaveLength(1)

    const replay = await db.selectFrom('replay').selectAll().where('id', '=', replayId).executeTakeFirstOrThrow()
    expect(replay.segment_count).toBe(1)
  })
})
