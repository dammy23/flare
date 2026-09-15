import { render, screen, waitFor } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { MemoryRouter } from 'react-router-dom'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { IssueListPage } from './IssueListPage'

const server = setupServer(
  http.get('http://localhost:3001/api/v1/projects/proj-1/issues', () =>
    HttpResponse.json([
      { id: 'issue-1', title: 'TypeError: boom', culprit: 'main in app.js', status: 'unresolved', timesSeen: 3, firstSeen: '2026-09-01T00:00:00.000Z', lastSeen: '2026-09-15T00:00:00.000Z' },
    ])
  )
)

beforeAll(() => server.listen())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('IssueListPage', () => {
  it('renders the fetched issue title', async () => {
    render(
      <MemoryRouter>
        <IssueListPage projectId="proj-1" />
      </MemoryRouter>
    )

    await waitFor(() => expect(screen.getByText('TypeError: boom')).toBeInTheDocument())
    expect(screen.getByText('main in app.js')).toBeInTheDocument()
  })
})
