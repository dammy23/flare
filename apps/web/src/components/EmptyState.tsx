import type { ReactNode } from 'react'

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flare-empty-state">
      <div className="flare-empty-state__title">{title}</div>
      {children}
    </div>
  )
}
