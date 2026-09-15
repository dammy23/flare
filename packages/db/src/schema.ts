import type { Generated } from 'kysely'

export interface Database {
  project: ProjectTable
  environment: EnvironmentTable
  issue: IssueTable
  issue_environment: IssueEnvironmentTable
  event: EventTable
  release: ReleaseTable
  source_map_artifact: SourceMapArtifactTable
  dashboard: DashboardTable
  dashboard_widget: DashboardWidgetTable
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
  release_id: string | null
  event_id: string
  timestamp: Date
  level: string | null
  message: string | null
  exception: unknown
  received_at: Generated<Date>
}

export interface ReleaseTable {
  id: Generated<string>
  project_id: string
  version: string
  created_at: Generated<Date>
}

export interface SourceMapArtifactTable {
  id: Generated<string>
  release_id: string
  file_path: string
  storage_key: string
  content_type: string | null
  created_at: Generated<Date>
}

export type WidgetEnvironmentMode = 'inherit' | 'pin'

export interface DashboardTable {
  id: Generated<string>
  project_id: string
  name: Generated<string>
  env_selector_default: string | null
  created_at: Generated<Date>
}

export interface DashboardWidgetTable {
  id: Generated<string>
  dashboard_id: string
  widget_type: string
  title: string
  layout: unknown
  config: Generated<unknown>
  environment_mode: Generated<WidgetEnvironmentMode>
  pinned_environment_name: string | null
  layout_updated_at: Generated<Date>
  config_updated_at: Generated<Date>
}
