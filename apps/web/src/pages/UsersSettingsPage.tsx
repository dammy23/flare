import { useEffect, useState } from 'react'
import { fetchUsers, setUserAdmin, type CurrentUser } from '../api/query-client'
import { useAuth } from '../AuthContext'
import { Table, type TableColumn } from '../components/Table'
import { Badge } from '../components/Badge'
import { Button } from '../components/Button'

export function UsersSettingsPage() {
  const { user: currentUser } = useAuth()
  const [users, setUsers] = useState<CurrentUser[] | null>(null)

  function reload() {
    fetchUsers().then(setUsers)
  }

  useEffect(reload, [])

  async function toggleAdmin(target: CurrentUser) {
    await setUserAdmin(target.id, !target.isAdmin)
    reload()
  }

  const columns: TableColumn<CurrentUser>[] = [
    { key: 'name', header: 'Name', render: (u) => u.name },
    { key: 'email', header: 'Email', render: (u) => u.email },
    {
      key: 'role',
      header: 'Role',
      render: (u) => <Badge variant={u.isAdmin ? 'info' : 'neutral'}>{u.isAdmin ? 'Admin' : 'Member'}</Badge>,
    },
    {
      key: 'actions',
      header: '',
      render: (u) => (
        <Button
          disabled={u.id === currentUser?.id && u.isAdmin}
          onClick={() => void toggleAdmin(u)}
          title={u.id === currentUser?.id && u.isAdmin ? 'You cannot remove your own admin access' : undefined}
        >
          {u.isAdmin ? 'Remove admin' : 'Make admin'}
        </Button>
      ),
    },
  ]

  return (
    <div className="flare-stack">
      <h1>Users</h1>
      {users === null ? <p>Loading…</p> : <Table columns={columns} rows={users} />}
    </div>
  )
}
