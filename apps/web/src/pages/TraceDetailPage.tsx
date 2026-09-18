import { useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { fetchTrace, type TraceSpan, type TraceTransaction } from '../api/query-client'

export function TraceDetailPage() {
  const { traceId } = useParams<{ traceId: string }>()
  const [searchParams] = useSearchParams()
  const projectId = searchParams.get('projectId')
  const [data, setData] = useState<{ transactions: TraceTransaction[]; spans: TraceSpan[] } | null>(null)

  useEffect(() => {
    if (traceId && projectId) fetchTrace(traceId, projectId).then(setData)
  }, [traceId, projectId])

  if (!data) return <p>Loading…</p>

  return (
    <div>
      {data.transactions.map((tx) => (
        <h2 key={tx.id}>{tx.name}</h2>
      ))}
      <ul>
        {data.spans.map((span) => (
          <li key={span.id}>
            <span>{span.op ?? '?'}</span>
            <span>{` — ${span.description ?? ''} (`}</span>
            <span>{`${span.duration_ms}ms`}</span>
            <span>{')'}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
