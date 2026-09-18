import { useEffect, useState, type FormEvent } from 'react'
import { createProject, deleteProject, fetchProjects, type ProjectSummary } from '../api/query-client'
import { Card } from '../components/Card'
import { Field, Input } from '../components/Input'
import { Button } from '../components/Button'
import { Table, type TableColumn } from '../components/Table'
import { EmptyState } from '../components/EmptyState'

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
}

export function ProjectsSettingsPage() {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  function reload() {
    fetchProjects().then(setProjects)
  }

  useEffect(reload, [])

  async function handleCreate(event: FormEvent) {
    event.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await createProject(name, slugify(name))
      setName('')
      reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to create project')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete(projectId: string) {
    await deleteProject(projectId)
    reload()
  }

  const columns: TableColumn<ProjectSummary>[] = [
    { key: 'name', header: 'Name', render: (p) => p.name },
    { key: 'slug', header: 'Slug', render: (p) => <code>{p.slug}</code> },
    { key: 'publicKey', header: 'DSN Public Key', render: (p) => <code>{p.publicKey}</code> },
    {
      key: 'actions',
      header: '',
      render: (p) => (
        <Button variant="danger" onClick={() => void handleDelete(p.id)}>
          Delete
        </Button>
      ),
    },
  ]

  return (
    <div className="flare-stack">
      <h1>Projects</h1>

      <Card title="New project">
        {error && <p className="flare-auth-error">{error}</p>}
        <form onSubmit={handleCreate}>
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>
          <Button type="submit" variant="primary" disabled={submitting}>
            {submitting ? 'Creating…' : 'Create project'}
          </Button>
        </form>
      </Card>

      {projects === null ? (
        <p>Loading…</p>
      ) : projects.length === 0 ? (
        <EmptyState title="No projects yet">Create one above to get started.</EmptyState>
      ) : (
        <Table columns={columns} rows={projects} />
      )}
    </div>
  )
}
