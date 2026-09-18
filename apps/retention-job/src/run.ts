import { createDb } from '@flare/db'
import { createStorageClient } from '@flare/storage'
import { runPartitionMaintenance } from './run-partition-maintenance'

const REPLAY_SEGMENT_RETENTION_DAYS = 30

async function main(): Promise<void> {
  const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')
  const storage = createStorageClient({
    endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
    region: process.env.S3_REGION ?? 'us-east-1',
    accessKeyId: process.env.S3_ACCESS_KEY ?? 'flare',
    secretAccessKey: process.env.S3_SECRET_KEY ?? 'flare12345',
    bucket: process.env.S3_BUCKET ?? 'flare-source-maps',
  })

  await runPartitionMaintenance(db)
  console.log('pg_partman maintenance complete')

  await storage.applyLifecycleRule('replay-segments-expiry', 'replays/', REPLAY_SEGMENT_RETENTION_DAYS)
  console.log(`applied ${REPLAY_SEGMENT_RETENTION_DAYS}-day lifecycle rule to replays/`)

  await db.destroy()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
