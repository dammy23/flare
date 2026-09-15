import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import type { IssueDetail } from '@flare/shared-types'
import { fetchIssue } from '../api/query-client'

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
            <code>{JSON.stringify(event.exception)}</code>
          </li>
        ))}
      </ul>
    </div>
  )
}
