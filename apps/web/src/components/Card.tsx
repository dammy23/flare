import type { ReactNode } from 'react'

export function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="flare-card">
      {title && <h2 className="flare-card__title">{title}</h2>}
      {children}
    </div>
  )
}
