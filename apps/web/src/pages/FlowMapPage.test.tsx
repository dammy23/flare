import { render, screen, waitFor } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { MemoryRouter } from 'react-router-dom'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { FlowMapPage } from './FlowMapPage'

const server = setupServer(
  http.get('http://localhost:3001/api/v1/flows/map', () =>
    HttpResponse.json([{ from: 'received', to: 'mastered', count: 4, avgDurationMs: 60000 }])
  )
)

beforeAll(() => server.listen())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('FlowMapPage', () => {
  it('renders each edge with its transition count and average duration', async () => {
    render(
      <MemoryRouter>
        <FlowMapPage projectId="proj-1" />
      </MemoryRouter>
    )

    await waitFor(() => expect(screen.getByText('received')).toBeInTheDocument())
    expect(screen.getByText('mastered')).toBeInTheDocument()
    expect(screen.getByText('4')).toBeInTheDocument()
    expect(screen.getByText('1.0m')).toBeInTheDocument()
  })

  it('shows an empty state when there are no transitions', async () => {
    server.use(http.get('http://localhost:3001/api/v1/flows/map', () => HttpResponse.json([])))

    render(
      <MemoryRouter>
        <FlowMapPage projectId="proj-1" />
      </MemoryRouter>
    )
    await waitFor(() => expect(screen.getByText('No transitions yet')).toBeInTheDocument())
  })
})
