import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { axisProps, chartColors, tooltipStyle } from './chart-theme'

export interface TrendPoint {
  day: string
  count: number
}

export function TrendArea({ data }: { data: TrendPoint[] }) {
  const formatted = data.map((row) => ({
    day: new Date(row.day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    count: Number(row.count),
  }))

  return (
    <ResponsiveContainer width="100%" height={200}>
      <AreaChart data={formatted}>
        <CartesianGrid stroke={chartColors.grid} vertical={false} />
        <XAxis dataKey="day" {...axisProps} />
        <YAxis allowDecimals={false} {...axisProps} />
        <Tooltip contentStyle={tooltipStyle} />
        <Area type="monotone" dataKey="count" stroke={chartColors.accent} fill={chartColors.accent} fillOpacity={0.2} strokeWidth={2} />
      </AreaChart>
    </ResponsiveContainer>
  )
}
