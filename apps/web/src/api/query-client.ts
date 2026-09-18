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

export async function fetchIssue(issueId: string, projectId: string): Promise<IssueDetail> {
  const response = await fetch(
    `${QUERY_API_BASE_URL}/api/v1/issues/${issueId}?projectId=${encodeURIComponent(projectId)}`
  )
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

export async function fetchTrace(
  traceId: string,
  projectId: string
): Promise<{ transactions: TraceTransaction[]; spans: TraceSpan[] }> {
  const response = await fetch(
    `${QUERY_API_BASE_URL}/api/v1/traces/${traceId}?projectId=${encodeURIComponent(projectId)}`
  )
  return response.json()
}

export interface ReplaySummary {
  id: string
  session_id: string
  duration_ms: number
  segment_count: number
  error_count: number
  started_at: string
}

export interface ReplaySegmentDto {
  sequence: number
  sizeBytes: number
  downloadUrl: string
}

export async function fetchReplays(projectId: string): Promise<ReplaySummary[]> {
  const response = await fetch(`${QUERY_API_BASE_URL}/api/v1/projects/${projectId}/replays`)
  return response.json()
}

export async function fetchReplay(
  replayId: string,
  projectId: string
): Promise<{ id: string; session_id: string; segments: ReplaySegmentDto[] }> {
  const response = await fetch(
    `${QUERY_API_BASE_URL}/api/v1/replays/${replayId}?projectId=${encodeURIComponent(projectId)}`
  )
  return response.json()
}

export interface FlowTraceDto {
  id: string
  project_id: string
  status: string
  current_stage: string | null
  started_at: string
  last_activity_at: string
}

export interface FlowStepDto {
  id: string
  stage_name: string
  system: string
  occurred_at: string
  status: string
  tech_trace_id: string | null
  issue_id: string | null
}

export interface FlowDeviationsDto {
  expectedStages: string[]
  observedStages: string[]
  skippedStages: string[]
  unexpectedStages: string[]
}

export async function fetchFlow(
  flowTraceId: string,
  projectId: string
): Promise<{ trace: FlowTraceDto; steps: FlowStepDto[]; deviations: FlowDeviationsDto | null }> {
  const response = await fetch(
    `${QUERY_API_BASE_URL}/api/v1/flows/${flowTraceId}?projectId=${encodeURIComponent(projectId)}`
  )
  return response.json()
}

export interface FlowBoardGroup {
  stage: string
  traces: { id: string; status: string; lastActivityAt: string }[]
}

export async function fetchFlowBoard(projectId: string): Promise<FlowBoardGroup[]> {
  const response = await fetch(`${QUERY_API_BASE_URL}/api/v1/flows/board?projectId=${encodeURIComponent(projectId)}`)
  return response.json()
}

export interface FlowMapEdge {
  from: string
  to: string
  count: number
  avgDurationMs: number | null
}

export async function fetchFlowMap(projectId: string): Promise<FlowMapEdge[]> {
  const response = await fetch(`${QUERY_API_BASE_URL}/api/v1/flows/map?projectId=${encodeURIComponent(projectId)}`)
  return response.json()
}
