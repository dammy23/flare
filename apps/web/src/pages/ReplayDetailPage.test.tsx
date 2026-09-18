import { render, screen, waitFor } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ReplayDetailPage } from './ReplayDetailPage'

const server = setupServer(
  http.get('http://localhost:3001/api/v1/replays/replay-1', () =>
    HttpResponse.json({
      id: 'replay-1',
      session_id: 'sess-1',
      segments: [{ sequence: 0, sizeBytes: 1024, downloadUrl: 'http://minio.local/replays/replay-1/0.bin?sig=x' }],
    })
  )
)

beforeAll(() => server.listen())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('ReplayDetailPage', () => {
  it('renders a download link per segment', async () => {
    render(
      <MemoryRouter initialEntries={['/replays/replay-1?projectId=proj-1']}>
        <Routes>
          <Route path="/replays/:replayId" element={<ReplayDetailPage />} />
        </Routes>
      </MemoryRouter>
    )
    await waitFor(() => expect(screen.getByText('Segment 0')).toBeInTheDocument())
    expect(screen.getByRole('link', { name: 'Segment 0' })).toHaveAttribute(
      'href',
      'http://minio.local/replays/replay-1/0.bin?sig=x'
    )
  })
})
