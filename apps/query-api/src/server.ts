import { createDb } from '@flare/db'
import { buildApp } from './app'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')
const app = buildApp({ db })

app.listen({ port: Number(process.env.PORT ?? 3001), host: '0.0.0.0' }).catch((error) => {
  app.log.error(error)
  process.exit(1)
})
