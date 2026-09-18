import type { ReactNode } from 'react'

export function Card({ title, className, children }: { title?: string; className?: string; children: ReactNode }) {
  return (
    <div className={`flare-card${className ? ` ${className}` : ''}`}>
      {title && <h2 className="flare-card__title">{title}</h2>}
      {children}
    </div>
  )
}
