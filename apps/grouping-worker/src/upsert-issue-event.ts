import type { Kysely } from 'kysely'
import type { Database } from '@flare/db'
import type { SentryEventItem } from '@flare/shared-types'
import { sql } from 'kysely'

export interface UpsertResult {
  issueId: string
  eventId: string
  created: boolean
  title: string
  timesSeen: number
}

function titleFrom(event: SentryEventItem): string {
  const primary = event.exception?.values?.[0]
  if (primary) return `${primary.type ?? 'Error'}: ${primary.value ?? ''}`.trim()
  return event.message ?? 'Unknown error'
}

function culpritFrom(event: SentryEventItem): string | null {
  const frame = event.exception?.values?.[0]?.stacktrace?.frames?.slice(-1)[0]
  if (!frame) return null
  return `${frame.function ?? '?'} in ${frame.filename ?? '?'}`
}

export async function upsertIssueAndEvent(
  db: Kysely<Database>,
  params: {
    projectId: string
    environmentId: string
    releaseId: string | null
    fingerprint: string
    event: SentryEventItem
  }
): Promise<UpsertResult> {
  const { projectId, environmentId, releaseId, fingerprint, event } = params

  return db.transaction().execute(async (trx) => {
    const existingIssue = await trx
      .selectFrom('issue')
      .select('id')
      .where('project_id', '=', projectId)
      .where('fingerprint', '=', fingerprint)
      .executeTakeFirst()

    const issue = existingIssue
      ? await trx
          .updateTable('issue')
          .set({ last_seen: new Date(), times_seen: sql`times_seen + 1` })
          .where('id', '=', existingIssue.id)
          .returning(['id', 'title', 'times_seen'])
          .executeTakeFirstOrThrow()
      : await trx
          .insertInto('issue')
          .values({
            project_id: projectId,
            fingerprint,
            title: titleFrom(event),
            culprit: culpritFrom(event),
            grouping_raw_components: JSON.stringify(event.exception ?? {}),
          })
          .returning(['id', 'title', 'times_seen'])
          .executeTakeFirstOrThrow()

    await trx
      .insertInto('issue_environment')
      .values({ issue_id: issue.id, environment_id: environmentId })
      .onConflict((oc) =>
        oc
          .columns(['issue_id', 'environment_id'])
          .doUpdateSet({ last_seen: new Date(), times_seen: sql`issue_environment.times_seen + 1` })
      )
      .execute()

    const insertedEvent = await trx
      .insertInto('event')
      .values({
        project_id: projectId,
        issue_id: issue.id,
        environment_id: environmentId,
        release_id: releaseId,
        event_id: event.event_id,
        timestamp: event.timestamp ? new Date(event.timestamp) : new Date(),
        level: event.level ?? null,
        message: event.message ?? null,
        exception: JSON.stringify(event.exception ?? null),
        breadcrumbs: event.breadcrumbs ? JSON.stringify(event.breadcrumbs) : null,
      })
      .onConflict((oc) => oc.columns(['project_id', 'event_id']).doNothing())
      .returning('id')
      .executeTakeFirst()

    // ON CONFLICT DO NOTHING returns no row on a duplicate (Kafka retry),
    // so the real Postgres id has to be looked up explicitly -- falling
    // back to the client-supplied event_id string here would hand
    // downstream consumers (symbolication's UPDATE ... WHERE id = eventId)
    // the wrong identifier shape on every retried delivery.
    const eventRow =
      insertedEvent ??
      (await trx
        .selectFrom('event')
        .select('id')
        .where('project_id', '=', projectId)
        .where('event_id', '=', event.event_id)
        .executeTakeFirstOrThrow())

    return {
      issueId: issue.id,
      eventId: eventRow.id,
      created: !existingIssue,
      title: issue.title,
      timesSeen: issue.times_seen,
    }
  })
}
