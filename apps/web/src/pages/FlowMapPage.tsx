import { useEffect, useState } from 'react'
import { fetchFlowMap, type FlowMapEdge } from '../api/query-client'
import { Table, type TableColumn } from '../components/Table'
import { EmptyState } from '../components/EmptyState'

function formatDuration(ms: number): string {
  const seconds = ms / 1000
  return seconds < 60 ? `${seconds.toFixed(1)}s` : `${(seconds / 60).toFixed(1)}m`
}

export function FlowMapPage({ projectId }: { projectId: string }) {
  const [edges, setEdges] = useState<(FlowMapEdge & { id: string })[] | null>(null)

  useEffect(() => {
    fetchFlowMap(projectId).then((rows) => setEdges(rows.map((edge, i) => ({ ...edge, id: String(i) }))))
  }, [projectId])

  if (edges === null) return <p>Loading…</p>
  if (edges.length === 0) return <EmptyState title="No transitions yet">The flow map fills in as checkpoints arrive.</EmptyState>

  const columns: TableColumn<FlowMapEdge & { id: string }>[] = [
    { key: 'from', header: 'From', render: (edge) => edge.from },
    { key: 'to', header: 'To', render: (edge) => edge.to },
    { key: 'count', header: 'Transitions', render: (edge) => edge.count },
    {
      key: 'avgDuration',
      header: 'Avg duration',
      render: (edge) => (edge.avgDurationMs !== null ? formatDuration(edge.avgDurationMs) : '—'),
    },
  ]

  return <Table columns={columns} rows={edges} />
}
