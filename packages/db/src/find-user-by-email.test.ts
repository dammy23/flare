import { afterAll, describe, expect, it } from 'vitest'
import { createDb } from './create-db'
import { createUser } from './create-user'
import { findUserByEmail } from './find-user-by-email'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')

afterAll(() => db.destroy())

describe('findUserByEmail', () => {
  it('returns the user including the password hash for a known email', async () => {
    const email = `find-${Date.now()}@example.test`
    await createUser(db, { email, passwordHash: 'a-bcrypt-hash', name: 'Grace Hopper', isAdmin: true })

    const found = await findUserByEmail(db, email)
    expect(found?.name).toBe('Grace Hopper')
    expect(found?.isAdmin).toBe(true)
    expect(found?.passwordHash).toBe('a-bcrypt-hash')
  })

  it('returns undefined for an unknown email', async () => {
    const found = await findUserByEmail(db, `nobody-${Date.now()}@example.test`)
    expect(found).toBeUndefined()
  })
})
