import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { fetchFlowBoard, type FlowBoardGroup } from '../api/query-client'

export function FlowBoardPage({ projectId }: { projectId: string }) {
  const [groups, setGroups] = useState<FlowBoardGroup[]>([])

  useEffect(() => {
    fetchFlowBoard(projectId).then(setGroups)
  }, [projectId])

  return (
    <div>
      {groups.map((group) => (
        <div key={group.stage}>
          <h2>{group.stage}</h2>
          <ul>
            {group.traces.map((trace) => (
              <li key={trace.id}>
                <Link to={`/flows/${trace.id}?projectId=${encodeURIComponent(projectId)}`}>{trace.id}</Link>
                <span>{` — ${trace.status}, last active ${trace.lastActivityAt}`}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}
