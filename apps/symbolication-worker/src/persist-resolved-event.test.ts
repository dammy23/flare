import { createDb } from '@flare/db'
import { afterAll, describe, expect, it } from 'vitest'
import { persistResolvedEvent } from './persist-resolved-event'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')

afterAll(() => db.destroy())

describe('persistResolvedEvent', () => {
  it('overwrites the event exception column with the resolved version', async () => {
    const project = await db
      .insertInto('project')
      .values({ name: 'Persist Test', slug: `persist-test-${Date.now()}`, public_key: `pk-persist-${Date.now()}` })
      .returningAll()
      .executeTakeFirstOrThrow()
    const environment = await db
      .insertInto('environment')
      .values({ project_id: project.id, name: 'production' })
      .returningAll()
      .executeTakeFirstOrThrow()
    const issue = await db
      .insertInto('issue')
      .values({ project_id: project.id, fingerprint: `fp-persist-${Date.now()}`, title: 'x', grouping_raw_components: '{}' })
      .returningAll()
      .executeTakeFirstOrThrow()
    const event = await db
      .insertInto('event')
      .values({
        project_id: project.id,
        issue_id: issue.id,
        environment_id: environment.id,
        event_id: `evt-persist-${Date.now()}`,
        timestamp: new Date(),
        exception: JSON.stringify({ values: [] }),
      })
      .returningAll()
      .executeTakeFirstOrThrow()

    await persistResolvedEvent(db, event.id, { values: [{ type: 'TypeError', value: 'resolved' }] })

    const updated = await db.selectFrom('event').selectAll().where('id', '=', event.id).executeTakeFirstOrThrow()
    expect((updated.exception as { values: Array<{ value: string }> }).values[0].value).toBe('resolved')
  })
})
