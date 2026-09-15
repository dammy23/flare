import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import type { IssueDetail } from '@flare/shared-types'
import { fetchIssue } from '../api/query-client'

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

export function IssueDetailPage() {
  const { issueId } = useParams<{ issueId: string }>()
  const [issue, setIssue] = useState<IssueDetail | null>(null)

  useEffect(() => {
    if (issueId) fetchIssue(issueId).then(setIssue)
  }, [issueId])

  if (!issue) return <p>Loading…</p>

  return (
    <div>
      <h1>{issue.title}</h1>
      <p>{issue.culprit}</p>
      <p>Status: {issue.status}</p>
      <ul>
        {issue.events.map((event) => (
          <li key={event.id}>
            <ExceptionFrames exception={event.exception} />
          </li>
        ))}
      </ul>
    </div>
  )
}
