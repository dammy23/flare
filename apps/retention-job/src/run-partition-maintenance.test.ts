import { afterAll, describe, expect, it } from 'vitest'
import { createDb } from '@flare/db'
import { runPartitionMaintenance } from './run-partition-maintenance'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')

afterAll(() => db.destroy())

describe('runPartitionMaintenance', () => {
  it('calls pg_partman run_maintenance() without throwing', async () => {
    await expect(runPartitionMaintenance(db)).resolves.not.toThrow()
  })
})
