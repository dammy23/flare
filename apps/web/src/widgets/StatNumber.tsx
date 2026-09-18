export function StatNumber({ value, label }: { value: number; label?: string }) {
  return (
    <div className="flare-stat">
      <div className="flare-stat__value">{value}</div>
      {label && <div className="flare-stat__label">{label}</div>}
    </div>
  )
}
