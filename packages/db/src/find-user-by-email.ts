import type { Kysely } from 'kysely'
import type { Database } from './schema'

export interface UserWithPasswordHash {
  id: string
  email: string
  name: string
  isAdmin: boolean
  passwordHash: string
}

export async function findUserByEmail(db: Kysely<Database>, email: string): Promise<UserWithPasswordHash | undefined> {
  const row = await db.selectFrom('user').selectAll().where('email', '=', email).executeTakeFirst()
  if (!row) return undefined

  return { id: row.id, email: row.email, name: row.name, isAdmin: row.is_admin, passwordHash: row.password_hash }
}
