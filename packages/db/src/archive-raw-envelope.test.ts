import { afterAll, describe, expect, it } from 'vitest'
import { createDb } from './create-db'
import { archiveRawEnvelope } from './archive-raw-envelope'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')

afterAll(() => db.destroy())

describe('archiveRawEnvelope', () => {
  it('stores the raw bytes verbatim, retrievable byte-for-byte', async () => {
    const project = await db
      .insertInto('project')
      .values({ name: 'Archive Test', slug: `archive-test-${Date.now()}`, public_key: `pk-archive-${Date.now()}` })
      .returningAll()
      .executeTakeFirstOrThrow()

    const rawBytes = Buffer.from('envelope-header\n{"type":"event"}\n{"event_id":"abc"}\n')
    const id = await archiveRawEnvelope(db, { projectId: project.id, eventId: 'abc', rawBytes })

    const row = await db.selectFrom('raw_envelope').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
    expect(Buffer.from(row.raw_bytes).equals(rawBytes)).toBe(true)
    expect(row.event_id).toBe('abc')
  })
})
