import { render, screen, waitFor } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { MemoryRouter } from 'react-router-dom'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { DashboardPage } from './DashboardPage'

const server = setupServer(
  http.get('http://localhost:3001/api/v1/projects/proj-1/dashboard', () =>
    HttpResponse.json({
      id: 'dash-1',
      projectId: 'proj-1',
      name: 'Default',
      envSelectorDefault: null,
      widgets: [
        {
          id: 'widget-1',
          widgetType: 'new_issues',
          title: 'New Issues',
          layout: { x: 0, y: 0, w: 6, h: 4 },
          config: { windowDays: 14 },
          environmentMode: 'inherit',
          pinnedEnvironmentName: null,
        },
        {
          id: 'widget-2',
          widgetType: 'replay_count',
          title: 'Replay Count',
          layout: { x: 6, y: 0, w: 6, h: 4 },
          config: { windowDays: 14 },
          environmentMode: 'inherit',
          pinnedEnvironmentName: null,
        },
      ],
    })
  ),
  http.get('http://localhost:3001/api/v1/widgets/widget-1/data', () =>
    HttpResponse.json({ data: [{ id: 'issue-1', title: 'TypeError: boom', culprit: null, times_seen: 1 }] })
  ),
  // replay_count's real backend response is a single object, not an
  // array -- this is the shape that previously broke the generic
  // WidgetChart's Array.isArray check.
  http.get('http://localhost:3001/api/v1/widgets/widget-2/data', () => HttpResponse.json({ data: { count: 3 } }))
)

beforeAll(() => server.listen())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('DashboardPage', () => {
  it('renders each widget by title once its data has loaded', async () => {
    render(
      <MemoryRouter>
        <DashboardPage projectId="proj-1" />
      </MemoryRouter>
    )

    await waitFor(() => expect(screen.getByText('New Issues')).toBeInTheDocument())
    expect(screen.getByText('TypeError: boom')).toBeInTheDocument()

    expect(screen.getByText('Replay Count')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('3')).toBeInTheDocument())
  })
})
