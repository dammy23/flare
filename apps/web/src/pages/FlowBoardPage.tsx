import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchFlowBoard, type FlowBoardGroup } from '../api/query-client'
import { Card } from '../components/Card'
import { Badge, type BadgeVariant } from '../components/Badge'
import { EmptyState } from '../components/EmptyState'

function statusVariant(status: string): BadgeVariant {
  return status === 'stalled' ? 'warning' : 'info'
}

export function FlowBoardPage({ projectId }: { projectId: string }) {
  const [groups, setGroups] = useState<FlowBoardGroup[] | null>(null)

  useEffect(() => {
    fetchFlowBoard(projectId).then(setGroups)
  }, [projectId])

  if (groups === null) return <p>Loading…</p>
  if (groups.length === 0) return <EmptyState title="Nothing in progress">Business-flow checkpoints will show up here.</EmptyState>

  return (
    <div className="flare-board">
      {groups.map((group) => (
        <Card key={group.stage} title={`${group.stage} (${group.traces.length})`} className="flare-board__column">
          <ul>
            {group.traces.map((trace) => (
              <li key={trace.id} className="flare-board__card">
                <Link to={`/flows/${trace.id}?projectId=${encodeURIComponent(projectId)}`}>{trace.id}</Link>
                <div>
                  <Badge variant={statusVariant(trace.status)}>{trace.status}</Badge>
                  <span className="flare-text-muted">{` last active ${new Date(trace.lastActivityAt).toLocaleString()}`}</span>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </div>
  )
}
