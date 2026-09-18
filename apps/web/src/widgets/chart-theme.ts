// Shared recharts styling constants, matching styles/tokens.css. Kept as
// literal hex rather than CSS var() references -- recharts portals some
// elements (tooltips, legends) outside the normal DOM tree in ways that
// don't always reliably inherit custom properties.
export const chartColors = {
  accent: '#ff8a3d',
  info: '#58a6ff',
  warning: '#e3b341',
  danger: '#f2495c',
  grid: '#2e323d',
  axis: '#9a9fad',
  tooltipBg: '#1c1f26',
  tooltipBorder: '#2e323d',
}

export const tooltipStyle = {
  background: chartColors.tooltipBg,
  border: `1px solid ${chartColors.tooltipBorder}`,
  borderRadius: 4,
  fontSize: 12,
}

export const axisProps = {
  stroke: chartColors.axis,
  fontSize: 11,
  tickLine: false,
  axisLine: false,
}
