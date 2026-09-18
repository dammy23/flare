import { render, screen, waitFor } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { TraceDetailPage } from './TraceDetailPage'

const server = setupServer(
  http.get('http://localhost:3001/api/v1/traces/trace-1', () =>
    HttpResponse.json({
      transactions: [{ id: 't1', name: 'GET /api/widgets', duration_ms: 120, start_ts: '2026-09-01T00:00:00.000Z' }],
      spans: [{ id: 's1', span_id: 'a', op: 'db.query', description: 'SELECT 1', duration_ms: 40 }],
    })
  )
)

beforeAll(() => server.listen())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('TraceDetailPage', () => {
  it('renders the transaction name and its span durations', async () => {
    render(
      <MemoryRouter initialEntries={['/traces/trace-1']}>
        <Routes>
          <Route path="/traces/:traceId" element={<TraceDetailPage />} />
        </Routes>
      </MemoryRouter>
    )

    await waitFor(() => expect(screen.getByText('GET /api/widgets')).toBeInTheDocument())
    expect(screen.getByText('db.query')).toBeInTheDocument()
    expect(screen.getByText('40ms')).toBeInTheDocument()
  })
})
