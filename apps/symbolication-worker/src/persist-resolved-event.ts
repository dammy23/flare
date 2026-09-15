import type { Kysely } from 'kysely'
import type { Database } from '@flare/db'

export async function persistResolvedEvent(
  db: Kysely<Database>,
  eventId: string,
  exception: unknown
): Promise<void> {
  await db.updateTable('event').set({ exception: JSON.stringify(exception) }).where('id', '=', eventId).execute()
}
