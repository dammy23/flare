import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { axisProps, chartColors, tooltipStyle } from './chart-theme'

export function CategoryBars({ data, categoryKey }: { data: Record<string, unknown>[]; categoryKey: string }) {
  const formatted = data.map((row) => ({
    category: String(row[categoryKey] ?? '—'),
    count: Number(row.count),
  }))

  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={formatted} layout="vertical" margin={{ left: 8 }}>
        <CartesianGrid stroke={chartColors.grid} horizontal={false} />
        <XAxis type="number" allowDecimals={false} {...axisProps} />
        <YAxis type="category" dataKey="category" width={100} {...axisProps} />
        <Tooltip contentStyle={tooltipStyle} />
        <Bar dataKey="count" fill={chartColors.accent} radius={[0, 4, 4, 0]} />
      </BarChart>
    </ResponsiveContainer>
  )
}
