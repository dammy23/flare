import { render, screen, waitFor } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { MemoryRouter } from 'react-router-dom'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ReplayListPage } from './ReplayListPage'

const server = setupServer(
  http.get('http://localhost:3001/api/v1/projects/proj-1/replays', () =>
    HttpResponse.json([
      { id: 'replay-1', session_id: 'sess-1', duration_ms: 5000, segment_count: 3, error_count: 1, started_at: '2026-09-01T00:00:00.000Z' },
    ])
  )
)

beforeAll(() => server.listen())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('ReplayListPage', () => {
  it('renders each replay session with its segment and error counts', async () => {
    render(
      <MemoryRouter>
        <ReplayListPage projectId="proj-1" />
      </MemoryRouter>
    )
    await waitFor(() => expect(screen.getByText('sess-1')).toBeInTheDocument())
    expect(screen.getByText('— 3 segments, 1 errors')).toBeInTheDocument()
    expect(screen.getByText('sess-1').closest('a')).toHaveAttribute('href', '/replays/replay-1?projectId=proj-1')
  })
})
