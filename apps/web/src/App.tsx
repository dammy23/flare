import { Route, Routes } from 'react-router-dom'
import { IssueDetailPage } from './pages/IssueDetailPage'
import { IssueListPage } from './pages/IssueListPage'

const PROJECT_ID = import.meta.env.VITE_PROJECT_ID ?? ''

export function App() {
  return (
    <Routes>
      <Route path="/" element={<IssueListPage projectId={PROJECT_ID} />} />
      <Route path="/issues/:issueId" element={<IssueDetailPage />} />
    </Routes>
  )
}
