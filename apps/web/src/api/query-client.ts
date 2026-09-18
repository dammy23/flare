import {
  DashboardSchema,
  IssueDetailSchema,
  IssueSummarySchema,
  type Dashboard,
  type IssueDetail,
  type IssueSummary,
} from '@flare/shared-types'

const QUERY_API_BASE_URL = import.meta.env.VITE_QUERY_API_URL ?? 'http://localhost:3001'

export class UnauthorizedError extends Error {}

// Always sends the session cookie cross-origin (query-api's CORS config
// allows this with `credentials: true`).
async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${QUERY_API_BASE_URL}${path}`, {
    ...init,
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...init.headers },
  })
}

// Normalizes a 401 into a typed error for authenticated-resource reads
// (every fetch* below except the auth endpoints themselves), so pages can
// handle "not logged in" the same way everywhere. NOT used by login/
// registerAccount -- their own 401 is a domain response ("wrong
// password"), not an auth-gate failure, and carries a real error message
// that this generic conversion would otherwise swallow.
async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(path, init)
  if (response.status === 401) throw new UnauthorizedError('not authenticated')
  return response.json() as Promise<T>
}

export interface CurrentUser {
  id: string
  email: string
  name: string
  isAdmin: boolean
}

export async function fetchMe(): Promise<CurrentUser | null> {
  try {
    const body = await apiJson<{ user: CurrentUser }>('/api/v1/me')
    return body.user
  } catch (error) {
    if (error instanceof UnauthorizedError) return null
    throw error
  }
}

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json()
    return typeof body?.error === 'string' ? body.error : fallback
  } catch {
    return fallback
  }
}

export async function registerAccount(email: string, password: string, name: string): Promise<CurrentUser> {
  const response = await apiFetch('/api/v1/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password, name }),
  })
  if (!response.ok) throw new Error(await readErrorMessage(response, 'registration failed'))
  return (await response.json()).user
}

export async function login(email: string, password: string): Promise<CurrentUser> {
  const response = await apiFetch('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })
  if (!response.ok) throw new Error(await readErrorMessage(response, 'login failed'))
  return (await response.json()).user
}

export async function logout(): Promise<void> {
  await apiFetch('/api/v1/auth/logout', { method: 'POST' })
}

export async function fetchIssues(projectId: string): Promise<IssueSummary[]> {
  const body = await apiJson(`/api/v1/projects/${projectId}/issues`)
  return IssueSummarySchema.array().parse(body)
}

export async function fetchIssue(issueId: string, projectId: string): Promise<IssueDetail> {
  const body = await apiJson(`/api/v1/issues/${issueId}?projectId=${encodeURIComponent(projectId)}`)
  return IssueDetailSchema.parse(body)
}

export async function fetchDashboard(projectId: string): Promise<Dashboard> {
  return DashboardSchema.parse(await apiJson(`/api/v1/projects/${projectId}/dashboard`))
}

export async function fetchWidgetData(widgetId: string, environment?: string): Promise<unknown> {
  const query = environment ? `?environment=${encodeURIComponent(environment)}` : ''
  const body = await apiJson<{ data: unknown }>(`/api/v1/widgets/${widgetId}/data${query}`)
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
  return apiJson(`/api/v1/traces/${traceId}?projectId=${encodeURIComponent(projectId)}`)
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
  return apiJson(`/api/v1/projects/${projectId}/replays`)
}

export async function fetchReplay(
  replayId: string,
  projectId: string
): Promise<{ id: string; session_id: string; segments: ReplaySegmentDto[] }> {
  return apiJson(`/api/v1/replays/${replayId}?projectId=${encodeURIComponent(projectId)}`)
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
  return apiJson(`/api/v1/flows/${flowTraceId}?projectId=${encodeURIComponent(projectId)}`)
}

export interface FlowBoardGroup {
  stage: string
  traces: { id: string; status: string; lastActivityAt: string }[]
}

export async function fetchFlowBoard(projectId: string): Promise<FlowBoardGroup[]> {
  return apiJson(`/api/v1/flows/board?projectId=${encodeURIComponent(projectId)}`)
}

export interface FlowMapEdge {
  from: string
  to: string
  count: number
  avgDurationMs: number | null
}

export async function fetchFlowMap(projectId: string): Promise<FlowMapEdge[]> {
  return apiJson(`/api/v1/flows/map?projectId=${encodeURIComponent(projectId)}`)
}

export interface ProjectSummary {
  id: string
  name: string
  slug: string
  publicKey: string
}

export async function fetchProjects(): Promise<ProjectSummary[]> {
  return apiJson('/api/v1/projects')
}

export async function createProject(name: string, slug: string): Promise<ProjectSummary> {
  const response = await apiFetch('/api/v1/projects', { method: 'POST', body: JSON.stringify({ name, slug }) })
  if (!response.ok) throw new Error(await readErrorMessage(response, 'failed to create project'))
  return response.json()
}

export async function deleteProject(projectId: string): Promise<void> {
  const response = await apiFetch(`/api/v1/projects/${projectId}`, { method: 'DELETE' })
  if (!response.ok) throw new Error(await readErrorMessage(response, 'failed to delete project'))
}

export async function fetchUsers(): Promise<CurrentUser[]> {
  return apiJson('/api/v1/users')
}

export async function setUserAdmin(userId: string, isAdmin: boolean): Promise<CurrentUser> {
  const response = await apiFetch(`/api/v1/users/${userId}`, { method: 'PATCH', body: JSON.stringify({ isAdmin }) })
  if (!response.ok) throw new Error(await readErrorMessage(response, 'failed to update user'))
  return response.json()
}
