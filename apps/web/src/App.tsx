import { Navigate, Route, Routes, useParams } from 'react-router-dom'
import { useAuth } from './AuthContext'
import { AppShell } from './components/AppShell'
import { RequireAdmin } from './components/RequireAdmin'
import { PROJECT_ID } from './config'
import { DashboardPage } from './pages/DashboardPage'
import { IssueDetailPage } from './pages/IssueDetailPage'
import { IssueListPage } from './pages/IssueListPage'
import { LoginPage } from './pages/LoginPage'
import { RegisterPage } from './pages/RegisterPage'
import { ReplayDetailPage } from './pages/ReplayDetailPage'
import { ReplayListPage } from './pages/ReplayListPage'
import { TraceDetailPage } from './pages/TraceDetailPage'
import { FlowDetailPage } from './pages/FlowDetailPage'
import { FlowBoardPage } from './pages/FlowBoardPage'
import { FlowMapPage } from './pages/FlowMapPage'
import { ProjectsSettingsPage } from './pages/ProjectsSettingsPage'
import { UsersSettingsPage } from './pages/UsersSettingsPage'

function DashboardRoute() {
  const { projectId } = useParams<{ projectId: string }>()
  return <DashboardPage projectId={projectId ?? ''} />
}

function ReplayListRoute() {
  const { projectId } = useParams<{ projectId: string }>()
  return <ReplayListPage projectId={projectId ?? ''} />
}

function FlowBoardRoute() {
  const { projectId } = useParams<{ projectId: string }>()
  return <FlowBoardPage projectId={projectId ?? ''} />
}

function FlowMapRoute() {
  const { projectId } = useParams<{ projectId: string }>()
  return <FlowMapPage projectId={projectId ?? ''} />
}

function AuthenticatedApp() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<IssueListPage projectId={PROJECT_ID} />} />
        <Route path="/issues/:issueId" element={<IssueDetailPage />} />
        <Route path="/projects/:projectId/dashboard" element={<DashboardRoute />} />
        <Route path="/projects/:projectId/replays" element={<ReplayListRoute />} />
        <Route path="/traces/:traceId" element={<TraceDetailPage />} />
        <Route path="/flows/:flowTraceId" element={<FlowDetailPage />} />
        <Route path="/projects/:projectId/flows/board" element={<FlowBoardRoute />} />
        <Route path="/projects/:projectId/flows/map" element={<FlowMapRoute />} />
        <Route path="/replays/:replayId" element={<ReplayDetailPage />} />
        <Route
          path="/settings/projects"
          element={
            <RequireAdmin>
              <ProjectsSettingsPage />
            </RequireAdmin>
          }
        />
        <Route
          path="/settings/users"
          element={
            <RequireAdmin>
              <UsersSettingsPage />
            </RequireAdmin>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  )
}

function UnauthenticatedApp() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  )
}

export function App() {
  const { user, loading } = useAuth()

  if (loading) return <p>Loading…</p>

  return user ? <AuthenticatedApp /> : <UnauthenticatedApp />
}
