import { render, screen, waitFor } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { AuthProvider } from '../AuthContext'
import { UsersSettingsPage } from './UsersSettingsPage'

let users = [
  { id: 'user-1', email: 'admin@example.test', name: 'Admin User', isAdmin: true },
  { id: 'user-2', email: 'member@example.test', name: 'Member User', isAdmin: false },
]

const server = setupServer(
  http.get('http://localhost:3001/api/v1/me', () => HttpResponse.json({ user: users[0] })),
  http.get('http://localhost:3001/api/v1/users', () => HttpResponse.json(users)),
  http.patch('http://localhost:3001/api/v1/users/user-2', async ({ request }) => {
    const body = (await request.json()) as { isAdmin: boolean }
    users = users.map((u) => (u.id === 'user-2' ? { ...u, isAdmin: body.isAdmin } : u))
    return HttpResponse.json(users[1])
  })
)

beforeAll(() => server.listen())
afterEach(() => {
  server.resetHandlers()
  users = [
    { id: 'user-1', email: 'admin@example.test', name: 'Admin User', isAdmin: true },
    { id: 'user-2', email: 'member@example.test', name: 'Member User', isAdmin: false },
  ]
})
afterAll(() => server.close())

describe('UsersSettingsPage', () => {
  it('lists users with their role', async () => {
    render(
      <AuthProvider>
        <UsersSettingsPage />
      </AuthProvider>
    )

    await waitFor(() => expect(screen.getByText('Admin User')).toBeInTheDocument())
    expect(screen.getByText('Member User')).toBeInTheDocument()
    expect(screen.getByText('Admin')).toBeInTheDocument()
    expect(screen.getByText('Member')).toBeInTheDocument()
  })

  it('promotes a member to admin', async () => {
    render(
      <AuthProvider>
        <UsersSettingsPage />
      </AuthProvider>
    )

    await waitFor(() => expect(screen.getByText('Member User')).toBeInTheDocument())
    screen.getByText('Make admin').click()

    await waitFor(() => expect(screen.getAllByText('Admin')).toHaveLength(2))
  })

  it('disables removing admin from your own account', async () => {
    render(
      <AuthProvider>
        <UsersSettingsPage />
      </AuthProvider>
    )

    await waitFor(() => expect(screen.getByText('Admin User')).toBeInTheDocument())
    const removeAdminButtons = screen.getAllByText('Remove admin')
    expect(removeAdminButtons[0]).toBeDisabled()
  })
})
