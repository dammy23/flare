import { useEffect, useState } from 'react'
import { fetchFlowMap, type FlowMapEdge } from '../api/query-client'

export function FlowMapPage({ projectId }: { projectId: string }) {
  const [edges, setEdges] = useState<FlowMapEdge[]>([])

  useEffect(() => {
    fetchFlowMap(projectId).then(setEdges)
  }, [projectId])

  return (
    <ul>
      {edges.map((edge, i) => (
        <li key={i}>
          <span>{`${edge.from} -> ${edge.to}`}</span>
          <span>{`: ${edge.count} transitions`}</span>
          {edge.avgDurationMs !== null && <span>{`, avg ${Math.round(edge.avgDurationMs)}ms`}</span>}
        </li>
      ))}
    </ul>
  )
}
