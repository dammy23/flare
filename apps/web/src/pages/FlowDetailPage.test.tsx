import { render, screen, waitFor } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { FlowDetailPage } from './FlowDetailPage'

const server = setupServer(
  http.get('http://localhost:3001/api/v1/flows/flow-1', () =>
    HttpResponse.json({
      trace: {
        id: 'flow-1',
        project_id: 'proj-1',
        status: 'in_progress',
        current_stage: 'mastered',
        started_at: '2026-09-18T12:00:00.000Z',
        last_activity_at: '2026-09-18T12:05:00.000Z',
      },
      steps: [
        {
          id: 's1',
          stage_name: 'received',
          system: 'Dynamics',
          occurred_at: '2026-09-18T12:00:00.000Z',
          status: 'ok',
          tech_trace_id: null,
          issue_id: null,
        },
        {
          id: 's2',
          stage_name: 'mastered',
          system: 'MDM',
          occurred_at: '2026-09-18T12:05:00.000Z',
          status: 'ok',
          tech_trace_id: 'trace-42',
          issue_id: 'issue-7',
        },
      ],
      deviations: {
        expectedStages: ['received', 'mastered', 'shipped'],
        observedStages: ['received', 'mastered'],
        skippedStages: ['shipped'],
        unexpectedStages: [],
      },
    })
  )
)

beforeAll(() => server.listen())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('FlowDetailPage', () => {
  it('renders the current stage and each step with its system and gap', async () => {
    render(
      <MemoryRouter initialEntries={['/flows/flow-1?projectId=proj-1']}>
        <Routes>
          <Route path="/flows/:flowTraceId" element={<FlowDetailPage />} />
        </Routes>
      </MemoryRouter>
    )

    await waitFor(() => expect(screen.getAllByText('mastered').length).toBeGreaterThan(0))
    expect(screen.getByText('received')).toBeInTheDocument()
    expect(screen.getByText('(Dynamics)')).toBeInTheDocument()
    expect(screen.getByText('(MDM)')).toBeInTheDocument()
    expect(screen.getByText('— 5.0m gap —')).toBeInTheDocument()
  })

  it('renders drill-down links for a step with tech_trace_id/issue_id, and skipped-stage deviations', async () => {
    render(
      <MemoryRouter initialEntries={['/flows/flow-1?projectId=proj-1']}>
        <Routes>
          <Route path="/flows/:flowTraceId" element={<FlowDetailPage />} />
        </Routes>
      </MemoryRouter>
    )

    await waitFor(() => expect(screen.getByText('view trace')).toBeInTheDocument())
    expect(screen.getByText('view trace').closest('a')).toHaveAttribute('href', '/traces/trace-42?projectId=proj-1')
    expect(screen.getByText('view issue').closest('a')).toHaveAttribute('href', '/issues/issue-7?projectId=proj-1')
    expect(screen.getByText('Skipped stages: shipped')).toBeInTheDocument()
  })
})
