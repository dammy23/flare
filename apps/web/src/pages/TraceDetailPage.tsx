import { useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { fetchTrace, type TraceSpan, type TraceTransaction } from '../api/query-client'
import { Card } from '../components/Card'
import { Table, type TableColumn } from '../components/Table'
import { DurationBar } from '../components/DurationBar'

export function TraceDetailPage() {
  const { traceId } = useParams<{ traceId: string }>()
  const [searchParams] = useSearchParams()
  const projectId = searchParams.get('projectId')
  const [data, setData] = useState<{ transactions: TraceTransaction[]; spans: TraceSpan[] } | null>(null)

  useEffect(() => {
    if (traceId && projectId) fetchTrace(traceId, projectId).then(setData)
  }, [traceId, projectId])

  if (!data) return <p>Loading…</p>

  const { transactions, spans } = data
  const maxMs = Math.max(...spans.map((s) => s.duration_ms), 1)

  const columns: TableColumn<TraceSpan>[] = [
    { key: 'op', header: 'Operation', render: (span) => span.op ?? '?' },
    { key: 'description', header: 'Description', render: (span) => span.description ?? '' },
    {
      key: 'duration',
      header: 'Duration',
      render: (span) => (
        <div>
          <span>{`${span.duration_ms}ms`}</span>
          <DurationBar durationMs={span.duration_ms} maxMs={maxMs} />
        </div>
      ),
    },
  ]

  return (
    <div className="flare-stack">
      {transactions.map((tx) => (
        <h2 key={tx.id}>{tx.name}</h2>
      ))}
      <Card title="Spans">
        <Table columns={columns} rows={spans} />
      </Card>
    </div>
  )
}
