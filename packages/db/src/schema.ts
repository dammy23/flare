import type { Generated } from 'kysely'

export interface Database {
  project: ProjectTable
  environment: EnvironmentTable
  issue: IssueTable
  issue_environment: IssueEnvironmentTable
  event: EventTable
}

export interface ProjectTable {
  id: Generated<string>
  name: string
  slug: string
  public_key: string
  created_at: Generated<Date>
}

export interface EnvironmentTable {
  id: Generated<string>
  project_id: string
  name: string
  created_at: Generated<Date>
}

export type IssueStatus = 'unresolved' | 'resolved' | 'ignored'

export interface IssueTable {
  id: Generated<string>
  project_id: string
  fingerprint: string
  title: string
  culprit: string | null
  status: Generated<IssueStatus>
  first_seen: Generated<Date>
  last_seen: Generated<Date>
  times_seen: Generated<number>
  grouping_raw_components: unknown
}

export interface IssueEnvironmentTable {
  issue_id: string
  environment_id: string
  first_seen: Generated<Date>
  last_seen: Generated<Date>
  times_seen: Generated<number>
}

export interface EventTable {
  id: Generated<string>
  project_id: string
  issue_id: string
  environment_id: string
  event_id: string
  timestamp: Date
  level: string | null
  message: string | null
  exception: unknown
  received_at: Generated<Date>
}
