import type { Kysely } from 'kysely'
import type { Database } from './schema'
import type { UserSummary } from './create-user'

export async function listUsers(db: Kysely<Database>): Promise<UserSummary[]> {
  const rows = await db.selectFrom('user').select(['id', 'email', 'name', 'is_admin']).orderBy('name', 'asc').execute()
  return rows.map((row) => ({ id: row.id, email: row.email, name: row.name, isAdmin: row.is_admin }))
}
