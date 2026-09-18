import { Route, Routes, useParams } from 'react-router-dom'
import { DashboardPage } from './pages/DashboardPage'
import { IssueDetailPage } from './pages/IssueDetailPage'
import { IssueListPage } from './pages/IssueListPage'
import { ReplayDetailPage } from './pages/ReplayDetailPage'
import { ReplayListPage } from './pages/ReplayListPage'
import { TraceDetailPage } from './pages/TraceDetailPage'

const PROJECT_ID = import.meta.env.VITE_PROJECT_ID ?? ''

function DashboardRoute() {
  const { projectId } = useParams<{ projectId: string }>()
  return <DashboardPage projectId={projectId ?? ''} />
}

function ReplayListRoute() {
  const { projectId } = useParams<{ projectId: string }>()
  return <ReplayListPage projectId={projectId ?? ''} />
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<IssueListPage projectId={PROJECT_ID} />} />
      <Route path="/issues/:issueId" element={<IssueDetailPage />} />
      <Route path="/projects/:projectId/dashboard" element={<DashboardRoute />} />
      <Route path="/projects/:projectId/replays" element={<ReplayListRoute />} />
      <Route path="/traces/:traceId" element={<TraceDetailPage />} />
      <Route path="/replays/:replayId" element={<ReplayDetailPage />} />
    </Routes>
  )
}
