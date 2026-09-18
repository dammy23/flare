import { Route, Routes, useParams } from 'react-router-dom'
import { DashboardPage } from './pages/DashboardPage'
import { IssueDetailPage } from './pages/IssueDetailPage'
import { IssueListPage } from './pages/IssueListPage'
import { TraceDetailPage } from './pages/TraceDetailPage'

const PROJECT_ID = import.meta.env.VITE_PROJECT_ID ?? ''

function DashboardRoute() {
  const { projectId } = useParams<{ projectId: string }>()
  return <DashboardPage projectId={projectId ?? ''} />
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<IssueListPage projectId={PROJECT_ID} />} />
      <Route path="/issues/:issueId" element={<IssueDetailPage />} />
      <Route path="/projects/:projectId/dashboard" element={<DashboardRoute />} />
      <Route path="/traces/:traceId" element={<TraceDetailPage />} />
    </Routes>
  )
}
