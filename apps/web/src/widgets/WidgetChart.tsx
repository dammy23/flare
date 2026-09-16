export function WidgetChart({ data }: { data: unknown }) {
  if (!Array.isArray(data)) return <p>No data</p>
  if (data.length === 0) return <p>No data in this window</p>
  return (
    <ul>
      {data.map((row, i) => (
        <li key={i}>{JSON.stringify(row)}</li>
      ))}
    </ul>
  )
}
