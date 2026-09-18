import type { Kysely } from 'kysely'
import type { Database } from './schema'
import type { UserSummary } from './create-user'

export async function setUserAdmin(db: Kysely<Database>, userId: string, isAdmin: boolean): Promise<UserSummary | undefined> {
  const row = await db
    .updateTable('user')
    .set({ is_admin: isAdmin })
    .where('id', '=', userId)
    .returning(['id', 'email', 'name', 'is_admin'])
    .executeTakeFirst()
  if (!row) return undefined

  return { id: row.id, email: row.email, name: row.name, isAdmin: row.is_admin }
}
