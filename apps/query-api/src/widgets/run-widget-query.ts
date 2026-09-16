import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { Database } from '@flare/db'
import { validateWidgetConfig, type WidgetConfigFor, type WidgetType } from '@flare/shared-types'

export interface WidgetScope {
  projectId: string
  environmentName: string | null
}

function daysAgo(days: number) {
  return sql<Date>`now() - (${days} * interval '1 day')`
}

async function issuesOverTime(db: Kysely<Database>, config: WidgetConfigFor<'issues_over_time'>, scope: WidgetScope) {
  let query = db
    .selectFrom('event')
    .select([sql<string>`date_trunc('day', "event"."timestamp")`.as('day'), sql<number>`count(*)`.as('count')])
    .where('event.project_id', '=', scope.projectId)
    .where('event.timestamp', '>=', daysAgo(config.days))

  if (scope.environmentName) {
    query = query
      .innerJoin('environment', 'environment.id', 'event.environment_id')
      .where('environment.name', '=', scope.environmentName)
  }

  return query
    .groupBy(sql`date_trunc('day', "event"."timestamp")`)
    .orderBy(sql`date_trunc('day', "event"."timestamp")`, 'asc')
    .execute()
}

async function topIssues(db: Kysely<Database>, config: WidgetConfigFor<'top_issues'>, scope: WidgetScope) {
  let query = db
    .selectFrom('issue')
    .innerJoin('issue_environment', 'issue_environment.issue_id', 'issue.id')
    .selectAll('issue')
    .select('issue_environment.times_seen as env_times_seen')
    .where('issue.project_id', '=', scope.projectId)
    .where('issue_environment.last_seen', '>=', daysAgo(config.windowDays))

  if (scope.environmentName) {
    query = query
      .innerJoin('environment', 'environment.id', 'issue_environment.environment_id')
      .where('environment.name', '=', scope.environmentName)
  }

  return query.orderBy('issue_environment.times_seen', 'desc').limit(config.limit).execute()
}

async function newIssues(db: Kysely<Database>, config: WidgetConfigFor<'new_issues'>, scope: WidgetScope) {
  let query = db
    .selectFrom('issue')
    .selectAll('issue')
    .where('issue.project_id', '=', scope.projectId)
    .where('issue.first_seen', '>=', daysAgo(config.windowDays))

  if (scope.environmentName) {
    query = query
      .innerJoin('issue_environment', 'issue_environment.issue_id', 'issue.id')
      .innerJoin('environment', 'environment.id', 'issue_environment.environment_id')
      .where('environment.name', '=', scope.environmentName)
  }

  return query.orderBy('issue.first_seen', 'desc').execute()
}

async function eventsByEnvironment(
  db: Kysely<Database>,
  config: WidgetConfigFor<'events_by_environment'>,
  scope: WidgetScope
) {
  return db
    .selectFrom('event')
    .innerJoin('environment', 'environment.id', 'event.environment_id')
    .select(['environment.name as environmentName', sql<number>`count(*)`.as('count')])
    .where('event.project_id', '=', scope.projectId)
    .where('event.timestamp', '>=', daysAgo(config.windowDays))
    .groupBy('environment.name')
    .execute()
}

export async function runWidgetQuery(
  db: Kysely<Database>,
  type: WidgetType,
  rawConfig: unknown,
  scope: WidgetScope
): Promise<unknown> {
  switch (type) {
    case 'issues_over_time':
      return issuesOverTime(db, validateWidgetConfig('issues_over_time', rawConfig), scope)
    case 'top_issues':
      return topIssues(db, validateWidgetConfig('top_issues', rawConfig), scope)
    case 'new_issues':
      return newIssues(db, validateWidgetConfig('new_issues', rawConfig), scope)
    case 'events_by_environment':
      return eventsByEnvironment(db, validateWidgetConfig('events_by_environment', rawConfig), scope)
  }
}
