import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { StatNumber } from './StatNumber'

describe('StatNumber', () => {
  it('renders the value and an optional label', () => {
    render(<StatNumber value={42} label="replays" />)
    expect(screen.getByText('42')).toBeInTheDocument()
    expect(screen.getByText('replays')).toBeInTheDocument()
  })

  it('renders the value without a label when none is given', () => {
    render(<StatNumber value={7} />)
    expect(screen.getByText('7')).toBeInTheDocument()
  })
})
