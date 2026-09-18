import type { ReactNode } from 'react'

export type BadgeVariant = 'danger' | 'success' | 'warning' | 'info' | 'neutral'

export function Badge({ variant = 'neutral', children }: { variant?: BadgeVariant; children: ReactNode }) {
  return <span className={`flare-badge flare-badge--${variant}`}>{children}</span>
}
