import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CategoryBars } from './CategoryBars'

describe('CategoryBars', () => {
  it('renders without throwing for a populated series', () => {
    expect(() =>
      render(<CategoryBars data={[{ environmentName: 'production', count: 5 }]} categoryKey="environmentName" />)
    ).not.toThrow()
  })
})
