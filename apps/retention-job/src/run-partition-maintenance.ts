import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { Database } from '@flare/db'

/**
 * Runs pg_partman's own maintenance entrypoint: creates upcoming
 * partitions and drops/detaches ones past their configured retention,
 * for every table registered in partman.part_config (today: just
 * `event`, per the retention set up in its create_parent migration).
 * Nothing Flare-specific to compute here -- pg_partman already owns
 * this logic once a table is registered with it.
 */
export async function runPartitionMaintenance(db: Kysely<Database>): Promise<void> {
  await sql`SELECT partman.run_maintenance()`.execute(db)
}
