import { afterAll, describe, expect, it } from 'vitest'
import { createDb } from './create-db'
import { createUser } from './create-user'
import { countUsers } from './count-users'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')

afterAll(() => db.destroy())

describe('countUsers', () => {
  it('increases after creating a user', async () => {
    const before = await countUsers(db)
    await createUser(db, {
      email: `count-${Date.now()}@example.test`,
      passwordHash: 'a-bcrypt-hash',
      name: 'Count Test',
      isAdmin: false,
    })
    const after = await countUsers(db)
    expect(after).toBe(before + 1)
  })
})
