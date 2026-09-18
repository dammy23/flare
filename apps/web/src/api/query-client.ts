import {
  DashboardSchema,
  IssueDetailSchema,
  IssueSummarySchema,
  type Dashboard,
  type IssueDetail,
  type IssueSummary,
} from '@flare/shared-types'

const QUERY_API_BASE_URL = import.meta.env.VITE_QUERY_API_URL ?? 'http://localhost:3001'

export async function fetchIssues(projectId: string): Promise<IssueSummary[]> {
  const response = await fetch(`${QUERY_API_BASE_URL}/api/v1/projects/${projectId}/issues`)
  const body = await response.json()
  return IssueSummarySchema.array().parse(body)
}

export async function fetchIssue(issueId: string): Promise<IssueDetail> {
  const response = await fetch(`${QUERY_API_BASE_URL}/api/v1/issues/${issueId}`)
  const body = await response.json()
  return IssueDetailSchema.parse(body)
}

export async function fetchDashboard(projectId: string): Promise<Dashboard> {
  const response = await fetch(`${QUERY_API_BASE_URL}/api/v1/projects/${projectId}/dashboard`)
  return DashboardSchema.parse(await response.json())
}

export async function fetchWidgetData(widgetId: string, environment?: string): Promise<unknown> {
  const query = environment ? `?environment=${encodeURIComponent(environment)}` : ''
  const response = await fetch(`${QUERY_API_BASE_URL}/api/v1/widgets/${widgetId}/data${query}`)
  const body = await response.json()
  return body.data
}

export interface TraceTransaction {
  id: string
  name: string
  duration_ms: number
  start_ts: string
}

export interface TraceSpan {
  id: string
  span_id: string
  op: string | null
  description: string | null
  duration_ms: number
}

export async function fetchTrace(traceId: string): Promise<{ transactions: TraceTransaction[]; spans: TraceSpan[] }> {
  const response = await fetch(`${QUERY_API_BASE_URL}/api/v1/traces/${traceId}`)
  return response.json()
}
