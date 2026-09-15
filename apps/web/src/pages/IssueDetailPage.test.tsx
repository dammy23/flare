import { render, screen, waitFor } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { IssueDetailPage } from './IssueDetailPage'

const server = setupServer(
  http.get('http://localhost:3001/api/v1/issues/issue-1', () =>
    HttpResponse.json({
      id: 'issue-1',
      title: 'TypeError: boom',
      culprit: null,
      status: 'unresolved',
      timesSeen: 1,
      firstSeen: '2026-09-01T00:00:00.000Z',
      lastSeen: '2026-09-01T00:00:00.000Z',
      events: [
        {
          id: 'event-1',
          timestamp: '2026-09-01T00:00:00.000Z',
          message: null,
          exception: {
            values: [
              {
                type: 'TypeError',
                value: 'boom',
                stacktrace: { frames: [{ filename: 'original.js', function: 'main', lineno: 10, colno: 2 }] },
              },
            ],
          },
        },
      ],
    })
  )
)

beforeAll(() => server.listen())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('IssueDetailPage', () => {
  it('renders resolved frame locations readably instead of raw JSON', async () => {
    render(
      <MemoryRouter initialEntries={['/issues/issue-1']}>
        <Routes>
          <Route path="/issues/:issueId" element={<IssueDetailPage />} />
        </Routes>
      </MemoryRouter>
    )

    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'TypeError: boom' })).toBeInTheDocument())
    expect(screen.getByText('main')).toBeInTheDocument()
    expect(screen.getByText('original.js:10:2')).toBeInTheDocument()
  })
})
