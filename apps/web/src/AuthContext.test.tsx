import { render, screen, waitFor } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { AuthProvider, useAuth } from './AuthContext'

const server = setupServer(
  http.get('http://localhost:3001/api/v1/me', () =>
    HttpResponse.json({ user: { id: 'user-1', email: 'user@example.test', name: 'Test User', isAdmin: true } })
  ),
  http.post('http://localhost:3001/api/v1/auth/logout', () => HttpResponse.json({ status: 'ok' }))
)

beforeAll(() => server.listen())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

function Probe() {
  const { user, loading, signOut } = useAuth()
  if (loading) return <p>loading</p>
  return (
    <div>
      <p>{user ? `logged in as ${user.email}` : 'logged out'}</p>
      <button onClick={() => void signOut()}>sign out</button>
    </div>
  )
}

describe('AuthProvider / useAuth', () => {
  it('loads the current user on mount', async () => {
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    )

    await waitFor(() => expect(screen.getByText('logged in as user@example.test')).toBeInTheDocument())
  })

  it('clears the user after signOut', async () => {
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    )

    await waitFor(() => expect(screen.getByText(/logged in as/)).toBeInTheDocument())
    screen.getByText('sign out').click()

    await waitFor(() => expect(screen.getByText('logged out')).toBeInTheDocument())
  })
})
