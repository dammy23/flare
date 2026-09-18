import type { WidgetType } from '@flare/shared-types'
import { TrendArea, type TrendPoint } from './TrendArea'
import { LatencyLines, type LatencyPoint } from './LatencyLines'
import { CategoryBars } from './CategoryBars'
import { RankedList, type RankedIssueRow } from './RankedList'
import { StatNumber } from './StatNumber'

function EmptyChart() {
  return <p className="flare-text-muted">No data in this window</p>
}

export function WidgetChart({
  widgetType,
  data,
  projectId,
}: {
  widgetType: WidgetType
  data: unknown
  projectId: string
}) {
  if (data === undefined) return <p className="flare-text-muted">Loading…</p>

  switch (widgetType) {
    case 'issues_over_time':
      return Array.isArray(data) && data.length > 0 ? <TrendArea data={data as TrendPoint[]} /> : <EmptyChart />

    case 'top_issues':
    case 'new_issues':
      return <RankedList data={(data as RankedIssueRow[] | undefined) ?? []} projectId={projectId} />

    case 'events_by_environment':
      return Array.isArray(data) && data.length > 0 ? (
        <CategoryBars data={data as Record<string, unknown>[]} categoryKey="environmentName" />
      ) : (
        <EmptyChart />
      )

    case 'flows_by_stage':
      return Array.isArray(data) && data.length > 0 ? (
        <CategoryBars data={data as Record<string, unknown>[]} categoryKey="current_stage" />
      ) : (
        <EmptyChart />
      )

    case 'transaction_latency':
      return Array.isArray(data) && data.length > 0 ? <LatencyLines data={data as LatencyPoint[]} /> : <EmptyChart />

    case 'replay_count': {
      const count = (data as { count?: number } | undefined)?.count ?? 0
      return <StatNumber value={Number(count)} label="replays" />
    }

    default:
      return <EmptyChart />
  }
}
