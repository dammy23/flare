import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { axisProps, chartColors, tooltipStyle } from './chart-theme'

export interface LatencyPoint {
  hour_bucket: string
  p50_ms: number
  p95_ms: number
  p99_ms: number
}

export function LatencyLines({ data }: { data: LatencyPoint[] }) {
  const formatted = data.map((row) => ({
    hour: new Date(row.hour_bucket).toLocaleTimeString(undefined, { hour: '2-digit' }),
    p50: Number(row.p50_ms),
    p95: Number(row.p95_ms),
    p99: Number(row.p99_ms),
  }))

  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={formatted}>
        <CartesianGrid stroke={chartColors.grid} vertical={false} />
        <XAxis dataKey="hour" {...axisProps} />
        <YAxis unit="ms" {...axisProps} />
        <Tooltip contentStyle={tooltipStyle} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Line type="monotone" dataKey="p50" name="p50" stroke={chartColors.info} strokeWidth={2} dot={false} />
        <Line type="monotone" dataKey="p95" name="p95" stroke={chartColors.warning} strokeWidth={2} dot={false} />
        <Line type="monotone" dataKey="p99" name="p99" stroke={chartColors.danger} strokeWidth={2} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  )
}
