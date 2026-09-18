import type { Kysely } from 'kysely'
import type { Database } from './schema'
import type { UserSummary } from './create-user'

export async function findUserById(db: Kysely<Database>, id: string): Promise<UserSummary | undefined> {
  const row = await db
    .selectFrom('user')
    .select(['id', 'email', 'name', 'is_admin'])
    .where('id', '=', id)
    .executeTakeFirst()
  if (!row) return undefined

  return { id: row.id, email: row.email, name: row.name, isAdmin: row.is_admin }
}
