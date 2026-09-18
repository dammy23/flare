import { Link } from 'react-router-dom'

export interface RankedIssueRow {
  id: string
  title: string
  culprit: string | null
  times_seen?: number
  env_times_seen?: number
}

export function RankedList({ data, projectId }: { data: RankedIssueRow[]; projectId: string }) {
  if (data.length === 0) return <p className="flare-text-muted">No issues in this window</p>

  return (
    <ul className="flare-ranked-list">
      {data.map((issue) => (
        <li key={issue.id}>
          <Link to={`/issues/${issue.id}?projectId=${encodeURIComponent(projectId)}`}>{issue.title}</Link>
          <span className="flare-text-muted">{` — ${issue.env_times_seen ?? issue.times_seen ?? 0}`}</span>
        </li>
      ))}
    </ul>
  )
}
