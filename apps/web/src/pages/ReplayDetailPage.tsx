import { useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { fetchReplay, type ReplaySegmentDto } from '../api/query-client'
import { Card } from '../components/Card'
import { Table, type TableColumn } from '../components/Table'
import { Button } from '../components/Button'

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`
}

export function ReplayDetailPage() {
  const { replayId } = useParams<{ replayId: string }>()
  const [searchParams] = useSearchParams()
  const projectId = searchParams.get('projectId')
  const [segments, setSegments] = useState<ReplaySegmentDto[] | null>(null)

  useEffect(() => {
    if (replayId && projectId) fetchReplay(replayId, projectId).then((r) => setSegments(r.segments))
  }, [replayId, projectId])

  if (!segments) return <p>Loading…</p>

  const columns: TableColumn<ReplaySegmentDto & { id: string }>[] = [
    { key: 'sequence', header: 'Segment', render: (segment) => `#${segment.sequence}` },
    { key: 'size', header: 'Size', render: (segment) => formatBytes(segment.sizeBytes) },
    {
      key: 'download',
      header: '',
      render: (segment) => (
        <a href={segment.downloadUrl}>
          <Button>Download</Button>
        </a>
      ),
    },
  ]

  return (
    <Card title="Replay segments">
      <p className="flare-text-muted">
        Live in-browser playback is not built yet — these are raw segment downloads for inspection.
      </p>
      <Table columns={columns} rows={segments.map((s) => ({ ...s, id: String(s.sequence) }))} />
    </Card>
  )
}
