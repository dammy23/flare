import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { LatencyLines } from './LatencyLines'

describe('LatencyLines', () => {
  it('renders without throwing for a populated series', () => {
    expect(() =>
      render(
        <LatencyLines
          data={[{ hour_bucket: '2026-09-01T00:00:00.000Z', p50_ms: 100, p95_ms: 200, p99_ms: 300 }]}
        />
      )
    ).not.toThrow()
  })
})
