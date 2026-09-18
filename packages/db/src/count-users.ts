import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { Database } from './schema'

export async function countUsers(db: Kysely<Database>): Promise<number> {
  const row = await db.selectFrom('user').select(sql<number>`count(*)`.as('count')).executeTakeFirstOrThrow()
  return Number(row.count)
}
