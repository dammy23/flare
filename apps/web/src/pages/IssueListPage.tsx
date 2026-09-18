import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { IssueSummary } from '@flare/shared-types'
import { fetchIssues } from '../api/query-client'
import { Table, type TableColumn } from '../components/Table'
import { Badge, type BadgeVariant } from '../components/Badge'
import { EmptyState } from '../components/EmptyState'

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

export function IssueListPage({ projectId }: { projectId: string }) {
  const [issues, setIssues] = useState<IssueSummary[] | null>(null)

  useEffect(() => {
    fetchIssues(projectId).then(setIssues)
  }, [projectId])

  if (issues === null) return <p>Loading…</p>
  if (issues.length === 0) return <EmptyState title="No issues yet">Errors will show up here once ingested.</EmptyState>

  const columns: TableColumn<IssueSummary>[] = [
    {
      key: 'title',
      header: 'Issue',
      render: (issue) => (
        <div>
          <Link to={`/issues/${issue.id}?projectId=${encodeURIComponent(projectId)}`}>{issue.title}</Link>
          {issue.culprit && <div className="flare-text-muted">{issue.culprit}</div>}
        </div>
      ),
    },
    { key: 'status', header: 'Status', render: (issue) => <Badge variant={statusVariant(issue.status)}>{issue.status}</Badge> },
    { key: 'timesSeen', header: 'Events', render: (issue) => issue.timesSeen },
    { key: 'lastSeen', header: 'Last Seen', render: (issue) => new Date(issue.lastSeen).toLocaleString() },
  ]

  return <Table columns={columns} rows={issues} />
}
