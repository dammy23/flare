import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchReplays, type ReplaySummary } from '../api/query-client'
import { Table, type TableColumn } from '../components/Table'
import { Badge } from '../components/Badge'
import { EmptyState } from '../components/EmptyState'

function formatDuration(ms: number): string {
  const seconds = ms / 1000
  return seconds < 60 ? `${seconds.toFixed(1)}s` : `${(seconds / 60).toFixed(1)}m`
}

export function ReplayListPage({ projectId }: { projectId: string }) {
  const [replays, setReplays] = useState<ReplaySummary[] | null>(null)

  useEffect(() => {
    fetchReplays(projectId).then(setReplays)
  }, [projectId])

  if (replays === null) return <p>Loading…</p>
  if (replays.length === 0) return <EmptyState title="No replays yet">Session replays will show up here once captured.</EmptyState>

  const columns: TableColumn<ReplaySummary>[] = [
    {
      key: 'session',
      header: 'Session',
      render: (replay) => <Link to={`/replays/${replay.id}?projectId=${encodeURIComponent(projectId)}`}>{replay.session_id}</Link>,
    },
    { key: 'duration', header: 'Duration', render: (replay) => formatDuration(replay.duration_ms) },
    { key: 'segments', header: 'Segments', render: (replay) => replay.segment_count },
    {
      key: 'errors',
      header: 'Errors',
      render: (replay) =>
        replay.error_count > 0 ? <Badge variant="danger">{replay.error_count}</Badge> : <Badge variant="neutral">0</Badge>,
    },
    { key: 'started', header: 'Started', render: (replay) => new Date(replay.started_at).toLocaleString() },
  ]

  return <Table columns={columns} rows={replays} />
}
