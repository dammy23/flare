import { afterAll, describe, expect, it } from 'vitest'
import { createDb } from './create-db'
import { createUser } from './create-user'
import { listUsers } from './list-users'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')

afterAll(() => db.destroy())

describe('listUsers', () => {
  it('includes a newly created user, without its password hash', async () => {
    const created = await createUser(db, {
      email: `list-${Date.now()}@example.test`,
      passwordHash: 'a-bcrypt-hash',
      name: 'List Users Test',
      isAdmin: false,
    })

    const users = await listUsers(db)
    const found = users.find((u) => u.id === created.id)
    expect(found?.email).toBe(created.email)
    expect((found as unknown as Record<string, unknown>)?.passwordHash).toBeUndefined()
  })
})
