import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { fetchFlow, type FlowStepDto, type FlowTraceDto } from '../api/query-client'

function formatGap(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = seconds / 60
  if (minutes < 60) return `${minutes.toFixed(1)}m`
  const hours = minutes / 60
  return `${hours.toFixed(1)}h`
}

export function FlowDetailPage() {
  const { flowTraceId } = useParams<{ flowTraceId: string }>()
  const [data, setData] = useState<{ trace: FlowTraceDto; steps: FlowStepDto[] } | null>(null)

  useEffect(() => {
    if (flowTraceId) fetchFlow(flowTraceId).then(setData)
  }, [flowTraceId])

  if (!data) return <p>Loading…</p>

  const { trace, steps } = data

  return (
    <div>
      <h1>{trace.current_stage ?? trace.status}</h1>
      <p>{`Status: ${trace.status}`}</p>
      <ul>
        {steps.map((step, i) => {
          const gap = i > 0 ? new Date(step.occurred_at).getTime() - new Date(steps[i - 1].occurred_at).getTime() : null
          return (
            <li key={step.id}>
              {gap !== null && <div>{`— ${formatGap(gap)} gap —`}</div>}
              <span>{step.stage_name}</span>
              <span>{` (${step.system})`}</span>
              <span>{` — ${step.occurred_at}`}</span>
              {step.status === 'error' && <span> [error]</span>}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
