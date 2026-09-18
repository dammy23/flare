import type { Kysely } from 'kysely'
import type { Database } from './schema'

export interface CreateUserParams {
  email: string
  passwordHash: string
  name: string
  isAdmin: boolean
}

export interface UserSummary {
  id: string
  email: string
  name: string
  isAdmin: boolean
}

export async function createUser(db: Kysely<Database>, params: CreateUserParams): Promise<UserSummary> {
  const row = await db
    .insertInto('user')
    .values({
      email: params.email,
      password_hash: params.passwordHash,
      name: params.name,
      is_admin: params.isAdmin,
    })
    .returning(['id', 'email', 'name', 'is_admin'])
    .executeTakeFirstOrThrow()

  return { id: row.id, email: row.email, name: row.name, isAdmin: row.is_admin }
}
