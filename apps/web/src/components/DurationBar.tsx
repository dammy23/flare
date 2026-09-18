export function DurationBar({ durationMs, maxMs }: { durationMs: number; maxMs: number }) {
  const pct = maxMs > 0 ? Math.min(Math.max((durationMs / maxMs) * 100, 2), 100) : 0
  return (
    <div className="flare-duration-bar-track">
      <div className="flare-duration-bar" style={{ width: `${pct}%` }} />
    </div>
  )
}
