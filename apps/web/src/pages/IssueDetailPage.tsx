import { useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import type { IssueDetail } from '@flare/shared-types'
import { fetchIssue } from '../api/query-client'
import { Card } from '../components/Card'
import { Badge, type BadgeVariant } from '../components/Badge'

interface StackFrame {
  filename?: string
  function?: string
  lineno?: number
  colno?: number
}

interface ExceptionValue {
  type?: string
  value?: string
  stacktrace?: { frames?: StackFrame[] }
}

function isExceptionShape(value: unknown): value is { values: ExceptionValue[] } {
  return typeof value === 'object' && value !== null && Array.isArray((value as { values?: unknown }).values)
}

function ExceptionFrames({ exception }: { exception: unknown }) {
  if (!isExceptionShape(exception)) return <code>{JSON.stringify(exception)}</code>

  return (
    <>
      {exception.values.map((value, i) => (
        <div key={i}>
          <strong>{`${value.type ?? 'Error'}: ${value.value ?? ''}`}</strong>
          <ul>
            {(value.stacktrace?.frames ?? []).map((frame, j) => (
              <li key={j}>
                <span>{frame.function ?? '?'}</span>
                {' — '}
                <span>{`${frame.filename ?? '?'}:${frame.lineno ?? '?'}:${frame.colno ?? '?'}`}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </>
  )
}

interface Breadcrumb {
  type?: string
  category?: string
  message?: string
  level?: string
  timestamp?: number | string
}

function isBreadcrumbsShape(value: unknown): value is { values: Breadcrumb[] } {
  return typeof value === 'object' && value !== null && Array.isArray((value as { values?: unknown }).values)
}

function levelVariant(level?: string): BadgeVariant {
  switch (level) {
    case 'error':
    case 'fatal':
      return 'danger'
    case 'warning':
      return 'warning'
    case 'info':
      return 'info'
    default:
      return 'neutral'
  }
}

function BreadcrumbTimeline({ breadcrumbs }: { breadcrumbs: unknown }) {
  if (!isBreadcrumbsShape(breadcrumbs) || breadcrumbs.values.length === 0) return null

  return (
    <div>
      <h3>Breadcrumbs</h3>
      <ul>
        {breadcrumbs.values.map((crumb, i) => (
          <li key={i}>
            <Badge variant={levelVariant(crumb.level)}>{crumb.category ?? crumb.type ?? 'default'}</Badge>
            <span>{` ${crumb.message ?? ''}`}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function statusVariant(status: string): BadgeVariant {
  switch (status) {
    case 'unresolved':
      return 'danger'
    case 'resolved':
      return 'success'
    default:
      return 'neutral'
  }
}

export function IssueDetailPage() {
  const { issueId } = useParams<{ issueId: string }>()
  const [searchParams] = useSearchParams()
  const projectId = searchParams.get('projectId')
  const [issue, setIssue] = useState<IssueDetail | null>(null)

  useEffect(() => {
    if (issueId && projectId) fetchIssue(issueId, projectId).then(setIssue)
  }, [issueId, projectId])

  if (!issue) return <p>Loading…</p>

  return (
    <div className="flare-stack">
      <div>
        <h1>{issue.title}</h1>
        <Badge variant={statusVariant(issue.status)}>{issue.status}</Badge>
        {issue.culprit && <p>{issue.culprit}</p>}
      </div>
      {issue.events.map((event) => (
        <Card key={event.id}>
          <ExceptionFrames exception={event.exception} />
          <BreadcrumbTimeline breadcrumbs={event.breadcrumbs} />
        </Card>
      ))}
    </div>
  )
}
