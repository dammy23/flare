import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { IssueSummary } from '@flare/shared-types'
import { fetchIssues } from '../api/query-client'

export function IssueListPage({ projectId }: { projectId: string }) {
  const [issues, setIssues] = useState<IssueSummary[]>([])

  useEffect(() => {
    fetchIssues(projectId).then(setIssues)
  }, [projectId])

  return (
    <ul>
      {issues.map((issue) => (
        <li key={issue.id}>
          <Link to={`/issues/${issue.id}`}>{issue.title}</Link>
          {issue.culprit && (
            <span>
              {' — '}
              <span>{issue.culprit}</span>
            </span>
          )}
          <span> ({issue.timesSeen})</span>
        </li>
      ))}
    </ul>
  )
}
