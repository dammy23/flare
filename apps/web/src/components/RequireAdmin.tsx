import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../AuthContext'

export function RequireAdmin({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  if (!user?.isAdmin) return <Navigate to="/" replace />
  return <>{children}</>
}
