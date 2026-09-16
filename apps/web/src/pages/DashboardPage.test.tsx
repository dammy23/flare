import { render, screen, waitFor } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
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
      ],
    })
  ),
  http.get('http://localhost:3001/api/v1/widgets/widget-1/data', () =>
    HttpResponse.json({ data: [{ id: 'issue-1', title: 'TypeError: boom' }] })
  )
)

beforeAll(() => server.listen())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('DashboardPage', () => {
  it('renders each widget by title once its data has loaded', async () => {
    render(<DashboardPage projectId="proj-1" />)

    await waitFor(() => expect(screen.getByText('New Issues')).toBeInTheDocument())
  })
})
