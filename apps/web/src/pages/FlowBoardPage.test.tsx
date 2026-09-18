import { render, screen, waitFor } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { MemoryRouter } from 'react-router-dom'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { FlowBoardPage } from './FlowBoardPage'

const server = setupServer(
  http.get('http://localhost:3001/api/v1/flows/board', () =>
    HttpResponse.json([
      {
        stage: 'received',
        traces: [{ id: 'flow-1', status: 'in_progress', lastActivityAt: '2026-09-18T12:00:00.000Z' }],
      },
      {
        stage: 'mastered',
        traces: [{ id: 'flow-2', status: 'stalled', lastActivityAt: '2026-09-18T10:00:00.000Z' }],
      },
    ])
  )
)

beforeAll(() => server.listen())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('FlowBoardPage', () => {
  it('renders each stage group with its traces', async () => {
    render(
      <MemoryRouter>
        <FlowBoardPage projectId="proj-1" />
      </MemoryRouter>
    )

    await waitFor(() => expect(screen.getByText('received')).toBeInTheDocument())
    expect(screen.getByText('mastered')).toBeInTheDocument()
    expect(screen.getByText('flow-1')).toBeInTheDocument()
    expect(screen.getByText('— stalled, last active 2026-09-18T10:00:00.000Z')).toBeInTheDocument()
    expect(screen.getByText('flow-1').closest('a')).toHaveAttribute('href', '/flows/flow-1?projectId=proj-1')
  })
})
