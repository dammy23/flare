import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TrendArea } from './TrendArea'

describe('TrendArea', () => {
  it('renders without throwing for a populated series', () => {
    expect(() =>
      render(<TrendArea data={[{ day: '2026-09-01T00:00:00.000Z', count: 3 }]} />)
    ).not.toThrow()
  })
})
