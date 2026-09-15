import { IssueDetailSchema, IssueSummarySchema, type IssueDetail, type IssueSummary } from '@flare/shared-types'

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
