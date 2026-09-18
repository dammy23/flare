import type { ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import { useAuth } from '../AuthContext'
import { PROJECT_ID } from '../config'

function NavItem({ to, children }: { to: string; children: ReactNode }) {
  return (
    <NavLink to={to} className={({ isActive }) => `flare-nav-link${isActive ? ' flare-nav-link--active' : ''}`}>
      {children}
    </NavLink>
  )
}

export function AppShell({ children }: { children: ReactNode }) {
  const { user, signOut } = useAuth()

  return (
    <div className="flare-shell">
      <aside className="flare-sidebar">
        <div className="flare-sidebar__logo">Flare</div>
        <div className="flare-sidebar__section">
          <NavItem to="/">Issues</NavItem>
          <NavItem to={`/projects/${PROJECT_ID}/dashboard`}>Dashboard</NavItem>
          <NavItem to={`/projects/${PROJECT_ID}/replays`}>Replays</NavItem>
          <NavItem to={`/projects/${PROJECT_ID}/flows/board`}>Flows</NavItem>
        </div>
        {user?.isAdmin && (
          <div className="flare-sidebar__section">
            <div className="flare-sidebar__section-title">Settings</div>
            <NavItem to="/settings/projects">Projects</NavItem>
            <NavItem to="/settings/users">Users</NavItem>
          </div>
        )}
      </aside>
      <div className="flare-main">
        <header className="flare-topbar">
          <div className="flare-topbar__user">
            <span>{user?.name}</span>
            <button className="flare-button" onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
        </header>
        <main className="flare-content">{children}</main>
      </div>
    </div>
  )
}
