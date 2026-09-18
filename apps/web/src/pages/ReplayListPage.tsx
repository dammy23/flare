import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchReplays, type ReplaySummary } from '../api/query-client'

export function ReplayListPage({ projectId }: { projectId: string }) {
  const [replays, setReplays] = useState<ReplaySummary[]>([])

  useEffect(() => {
    fetchReplays(projectId).then(setReplays)
  }, [projectId])

  return (
    <ul>
      {replays.map((replay) => (
        <li key={replay.id}>
          <Link to={`/replays/${replay.id}`}>{replay.session_id}</Link>
          <span>{` — ${replay.segment_count} segments, ${replay.error_count} errors`}</span>
        </li>
      ))}
    </ul>
  )
}
