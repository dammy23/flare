import { useEffect, useState } from 'react'
import GridLayout from 'react-grid-layout'
import type { Dashboard } from '@flare/shared-types'
import { fetchDashboard, fetchWidgetData } from '../api/query-client'
import { WidgetChart } from '../widgets/WidgetChart'

export function DashboardPage({ projectId }: { projectId: string }) {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null)
  const [dataByWidget, setDataByWidget] = useState<Record<string, unknown>>({})

  useEffect(() => {
    fetchDashboard(projectId).then((result) => {
      setDashboard(result)
      for (const widget of result.widgets) {
        fetchWidgetData(widget.id).then((data) => {
          setDataByWidget((prev) => ({ ...prev, [widget.id]: data }))
        })
      }
    })
  }, [projectId])

  if (!dashboard) return <p>Loading…</p>

  const layout = dashboard.widgets.map((widget) => ({ i: widget.id, ...widget.layout }))

  return (
    <GridLayout layout={layout} cols={12} rowHeight={60} width={1200}>
      {dashboard.widgets.map((widget) => (
        <div key={widget.id}>
          <h3>{widget.title}</h3>
          <WidgetChart data={dataByWidget[widget.id]} />
        </div>
      ))}
    </GridLayout>
  )
}
