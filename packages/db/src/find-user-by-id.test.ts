import { afterAll, describe, expect, it } from 'vitest'
import { createDb } from './create-db'
import { createUser } from './create-user'
import { findUserById } from './find-user-by-id'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')

afterAll(() => db.destroy())

describe('findUserById', () => {
  it('returns the user summary for a known id', async () => {
    const created = await createUser(db, {
      email: `byid-${Date.now()}@example.test`,
      passwordHash: 'a-bcrypt-hash',
      name: 'By Id Test',
      isAdmin: false,
    })

    const found = await findUserById(db, created.id)
    expect(found?.email).toBe(created.email)
  })

  it('returns undefined for an unknown id', async () => {
    const found = await findUserById(db, '00000000-0000-0000-0000-000000000000')
    expect(found).toBeUndefined()
  })
})
