import { createDb } from '@flare/db'
import Redis from 'ioredis'
import { buildApp } from './app'
import { createKafkaProducer } from './kafka/producer'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379')
const producer = createKafkaProducer((process.env.KAFKA_BROKERS ?? 'localhost:9092').split(','))

async function main(): Promise<void> {
  await producer.connect()
  const app = buildApp({ db, redis, producer })
  await app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' })
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
