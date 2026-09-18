import { render, screen, waitFor } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { MemoryRouter } from 'react-router-dom'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { App } from './App'
import { AuthProvider } from './AuthContext'

const server = setupServer(http.get('http://localhost:3001/api/v1/me', () => new HttpResponse(null, { status: 401 })))

beforeAll(() => server.listen())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('App', () => {
  it('shows the login page when there is no session', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>
    )

    await waitFor(() => expect(screen.getByText('Sign in')).toBeInTheDocument())
  })

  it('shows the app shell once a session exists', async () => {
    server.use(
      http.get('http://localhost:3001/api/v1/me', () =>
        HttpResponse.json({ user: { id: 'user-1', email: 'user@example.test', name: 'Shell Test User', isAdmin: false } })
      ),
      http.get('http://localhost:3001/api/v1/projects/*/issues', () => HttpResponse.json([]))
    )

    render(
      <MemoryRouter initialEntries={['/']}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>
    )

    await waitFor(() => expect(screen.getByText('Shell Test User')).toBeInTheDocument())
    expect(screen.getByText('Sign out')).toBeInTheDocument()
  })
})
