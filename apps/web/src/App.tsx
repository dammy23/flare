import { Route, Routes, useParams } from 'react-router-dom'
import { DashboardPage } from './pages/DashboardPage'
import { IssueDetailPage } from './pages/IssueDetailPage'
import { IssueListPage } from './pages/IssueListPage'
import { ReplayDetailPage } from './pages/ReplayDetailPage'
import { ReplayListPage } from './pages/ReplayListPage'
import { TraceDetailPage } from './pages/TraceDetailPage'
import { FlowDetailPage } from './pages/FlowDetailPage'
import { FlowBoardPage } from './pages/FlowBoardPage'
import { FlowMapPage } from './pages/FlowMapPage'

const PROJECT_ID = import.meta.env.VITE_PROJECT_ID ?? ''

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

export function App() {
  return (
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
    </Routes>
  )
}
