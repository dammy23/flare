import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { WidgetChart } from './WidgetChart'

function renderWidget(widgetType: Parameters<typeof WidgetChart>[0]['widgetType'], data: unknown) {
  return render(
    <MemoryRouter>
      <WidgetChart widgetType={widgetType} data={data} projectId="proj-1" />
    </MemoryRouter>
  )
}

describe('WidgetChart', () => {
  it('shows a loading state while data is undefined', () => {
    renderWidget('new_issues', undefined)
    expect(screen.getByText('Loading…')).toBeInTheDocument()
  })

  it('renders replay_count as a single-object stat, not an array-shaped empty state', () => {
    // replay_count's backend query (executeTakeFirstOrThrow) returns a
    // single { count } object, not an array -- the original generic
    // WidgetChart's Array.isArray check would have shown "No data" for
    // this widget type; the dispatcher must special-case it.
    renderWidget('replay_count', { count: 5 })
    expect(screen.getByText('5')).toBeInTheDocument()
    expect(screen.getByText('replays')).toBeInTheDocument()
  })

  it('defaults replay_count to 0 when the count field is missing', () => {
    renderWidget('replay_count', {})
    expect(screen.getByText('0')).toBeInTheDocument()
  })

  it('renders top_issues and new_issues through RankedList', () => {
    renderWidget('top_issues', [{ id: 'issue-1', title: 'TypeError: boom', culprit: null, times_seen: 1 }])
    expect(screen.getByText('TypeError: boom')).toBeInTheDocument()
  })

  it('renders an empty state for issues_over_time with no rows', () => {
    renderWidget('issues_over_time', [])
    expect(screen.getByText('No data in this window')).toBeInTheDocument()
  })

  it('renders an empty state for issues_over_time when data is not an array', () => {
    renderWidget('issues_over_time', null)
    expect(screen.getByText('No data in this window')).toBeInTheDocument()
  })

  it('renders events_by_environment and flows_by_stage without throwing when populated', () => {
    expect(() => renderWidget('events_by_environment', [{ environmentName: 'production', count: 2 }])).not.toThrow()
    expect(() => renderWidget('flows_by_stage', [{ current_stage: 'received', count: 1 }])).not.toThrow()
  })

  it('renders transaction_latency without throwing when populated', () => {
    expect(() =>
      renderWidget('transaction_latency', [
        { hour_bucket: '2026-09-01T00:00:00.000Z', p50_ms: 100, p95_ms: 200, p99_ms: 300 },
      ])
    ).not.toThrow()
  })
})
