import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { fetchReplay, type ReplaySegmentDto } from '../api/query-client'

export function ReplayDetailPage() {
  const { replayId } = useParams<{ replayId: string }>()
  const [segments, setSegments] = useState<ReplaySegmentDto[] | null>(null)

  useEffect(() => {
    if (replayId) fetchReplay(replayId).then((r) => setSegments(r.segments))
  }, [replayId])

  if (!segments) return <p>Loading…</p>

  return (
    <div>
      <p>
        Live in-browser playback is not built yet — these are raw segment
        downloads for inspection.
      </p>
      <ul>
        {segments.map((segment) => (
          <li key={segment.sequence}>
            <a href={segment.downloadUrl}>{`Segment ${segment.sequence}`}</a>
          </li>
        ))}
      </ul>
    </div>
  )
}
