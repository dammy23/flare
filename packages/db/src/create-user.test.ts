import { afterAll, describe, expect, it } from 'vitest'
import { createDb } from './create-db'
import { createUser } from './create-user'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')

afterAll(() => db.destroy())

describe('createUser', () => {
  it('creates a user and never returns the password hash', async () => {
    const user = await createUser(db, {
      email: `user-${Date.now()}@example.test`,
      passwordHash: 'a-bcrypt-hash',
      name: 'Ada Lovelace',
      isAdmin: false,
    })

    expect(user.name).toBe('Ada Lovelace')
    expect(user.isAdmin).toBe(false)
    expect((user as unknown as Record<string, unknown>).passwordHash).toBeUndefined()
    expect((user as unknown as Record<string, unknown>).password_hash).toBeUndefined()
  })

  it('rejects a duplicate email', async () => {
    const email = `dup-${Date.now()}@example.test`
    await createUser(db, { email, passwordHash: 'hash-1', name: 'First', isAdmin: false })

    await expect(createUser(db, { email, passwordHash: 'hash-2', name: 'Second', isAdmin: false })).rejects.toThrow()
  })
})
