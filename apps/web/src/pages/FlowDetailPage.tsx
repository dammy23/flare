import { useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { fetchFlow, type FlowDeviationsDto, type FlowStepDto, type FlowTraceDto } from '../api/query-client'

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
  const [searchParams] = useSearchParams()
  const projectId = searchParams.get('projectId')
  const [data, setData] = useState<{ trace: FlowTraceDto; steps: FlowStepDto[]; deviations: FlowDeviationsDto | null } | null>(
    null
  )

  useEffect(() => {
    if (flowTraceId && projectId) fetchFlow(flowTraceId, projectId).then(setData)
  }, [flowTraceId, projectId])

  if (!data) return <p>Loading…</p>

  const { trace, steps, deviations } = data

  return (
    <div>
      <h1>{trace.current_stage ?? trace.status}</h1>
      <p>{`Status: ${trace.status}`}</p>
      {deviations && (deviations.skippedStages.length > 0 || deviations.unexpectedStages.length > 0) && (
        <div>
          {deviations.skippedStages.length > 0 && <p>{`Skipped stages: ${deviations.skippedStages.join(', ')}`}</p>}
          {deviations.unexpectedStages.length > 0 && (
            <p>{`Unexpected stages: ${deviations.unexpectedStages.join(', ')}`}</p>
          )}
        </div>
      )}
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
              {step.tech_trace_id && (
                <span>
                  {' '}
                  <Link to={`/traces/${step.tech_trace_id}?projectId=${encodeURIComponent(trace.project_id)}`}>
                    view trace
                  </Link>
                </span>
              )}
              {step.issue_id && (
                <span>
                  {' '}
                  <Link to={`/issues/${step.issue_id}?projectId=${encodeURIComponent(trace.project_id)}`}>
                    view issue
                  </Link>
                </span>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
