import { createDb } from '@flare/db'
import { markStalledTraces } from './mark-stalled-traces'

async function main(): Promise<void> {
  const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')
  const count = await markStalledTraces(db)
  console.log(`marked ${count} trace(s) stalled`)
  await db.destroy()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
