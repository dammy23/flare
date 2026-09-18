import { afterAll, describe, expect, it } from 'vitest'
import { createDb } from './create-db'
import { createUser } from './create-user'
import { setUserAdmin } from './set-user-admin'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')

afterAll(() => db.destroy())

describe('setUserAdmin', () => {
  it('promotes a user to admin', async () => {
    const created = await createUser(db, {
      email: `promote-${Date.now()}@example.test`,
      passwordHash: 'a-bcrypt-hash',
      name: 'Promote Test',
      isAdmin: false,
    })

    const updated = await setUserAdmin(db, created.id, true)
    expect(updated?.isAdmin).toBe(true)
  })

  it('returns undefined for an unknown user id', async () => {
    const updated = await setUserAdmin(db, '00000000-0000-0000-0000-000000000000', true)
    expect(updated).toBeUndefined()
  })
})
