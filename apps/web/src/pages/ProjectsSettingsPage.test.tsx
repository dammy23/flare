import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ProjectsSettingsPage } from './ProjectsSettingsPage'

let projects = [{ id: 'proj-1', name: 'Existing App', slug: 'existing-app', publicKey: 'pk-existing' }]

const server = setupServer(
  http.get('http://localhost:3001/api/v1/projects', () => HttpResponse.json(projects)),
  http.post('http://localhost:3001/api/v1/projects', async ({ request }) => {
    const body = (await request.json()) as { name: string; slug: string }
    const created = { id: 'proj-2', name: body.name, slug: body.slug, publicKey: 'pk-new' }
    projects = [...projects, created]
    return HttpResponse.json(created, { status: 201 })
  }),
  http.delete('http://localhost:3001/api/v1/projects/proj-1', () => {
    projects = projects.filter((p) => p.id !== 'proj-1')
    return new HttpResponse(null, { status: 204 })
  })
)

beforeAll(() => server.listen())
afterEach(() => {
  server.resetHandlers()
  projects = [{ id: 'proj-1', name: 'Existing App', slug: 'existing-app', publicKey: 'pk-existing' }]
})
afterAll(() => server.close())

describe('ProjectsSettingsPage', () => {
  it('lists existing projects', async () => {
    render(<ProjectsSettingsPage />)
    await waitFor(() => expect(screen.getByText('Existing App')).toBeInTheDocument())
    expect(screen.getByText('existing-app')).toBeInTheDocument()
  })

  it('creates a project and shows it in the list', async () => {
    render(<ProjectsSettingsPage />)
    await waitFor(() => expect(screen.getByText('Existing App')).toBeInTheDocument())

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Brand New App' } })
    fireEvent.click(screen.getByText('Create project'))

    await waitFor(() => expect(screen.getByText('Brand New App')).toBeInTheDocument())
  })

  it('deletes a project', async () => {
    render(<ProjectsSettingsPage />)
    await waitFor(() => expect(screen.getByText('Existing App')).toBeInTheDocument())

    fireEvent.click(screen.getByText('Delete'))

    await waitFor(() => expect(screen.queryByText('Existing App')).not.toBeInTheDocument())
  })
})
