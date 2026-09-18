import { useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { fetchFlow, type FlowDeviationsDto, type FlowStepDto, type FlowTraceDto } from '../api/query-client'
import { Card } from '../components/Card'
import { Badge, type BadgeVariant } from '../components/Badge'

function formatGap(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = seconds / 60
  if (minutes < 60) return `${minutes.toFixed(1)}m`
  const hours = minutes / 60
  return `${hours.toFixed(1)}h`
}

function traceStatusVariant(status: string): BadgeVariant {
  switch (status) {
    case 'stalled':
      return 'warning'
    case 'completed':
      return 'success'
    case 'abandoned':
      return 'danger'
    default:
      return 'info'
  }
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
  const hasDeviations = deviations && (deviations.skippedStages.length > 0 || deviations.unexpectedStages.length > 0)

  return (
    <div className="flare-stack">
      <div>
        <h1>{trace.current_stage ?? trace.status}</h1>
        <Badge variant={traceStatusVariant(trace.status)}>{trace.status}</Badge>
      </div>

      {hasDeviations && (
        <Card title="Deviations">
          {deviations!.skippedStages.length > 0 && (
            <p>
              <Badge variant="warning">Skipped</Badge>
              <span>{` ${deviations!.skippedStages.join(', ')}`}</span>
            </p>
          )}
          {deviations!.unexpectedStages.length > 0 && (
            <p>
              <Badge variant="info">Unexpected</Badge>
              <span>{` ${deviations!.unexpectedStages.join(', ')}`}</span>
            </p>
          )}
        </Card>
      )}

      <Card title="Timeline">
        <ul className="flare-timeline">
          {steps.map((step, i) => {
            const gap = i > 0 ? new Date(step.occurred_at).getTime() - new Date(steps[i - 1].occurred_at).getTime() : null
            return (
              <li key={step.id} className="flare-timeline-step">
                {gap !== null && <div className="flare-text-muted">{`— ${formatGap(gap)} gap —`}</div>}
                <div className="flare-timeline-step__row">
                  <span>
                    <strong>{step.stage_name}</strong>
                    <span className="flare-text-muted">{` (${step.system})`}</span>
                    <span className="flare-text-muted">{` — ${step.occurred_at}`}</span>
                    {step.status === 'error' && <Badge variant="danger">error</Badge>}
                  </span>
                  <span>
                    {step.tech_trace_id && (
                      <Link to={`/traces/${step.tech_trace_id}?projectId=${encodeURIComponent(trace.project_id)}`}>
                        view trace
                      </Link>
                    )}
                    {step.issue_id && (
                      <Link to={`/issues/${step.issue_id}?projectId=${encodeURIComponent(trace.project_id)}`}>
                        view issue
                      </Link>
                    )}
                  </span>
                </div>
              </li>
            )
          })}
        </ul>
      </Card>
    </div>
  )
}
