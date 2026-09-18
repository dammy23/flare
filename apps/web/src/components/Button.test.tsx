import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Button } from './Button'

describe('Button', () => {
  it('applies the default variant class when no variant is given', () => {
    render(<Button>Click me</Button>)
    expect(screen.getByText('Click me')).toHaveClass('flare-button')
    expect(screen.getByText('Click me')).not.toHaveClass('flare-button--primary')
  })

  it('applies the primary variant class', () => {
    render(<Button variant="primary">Save</Button>)
    expect(screen.getByText('Save')).toHaveClass('flare-button', 'flare-button--primary')
  })

  it('preserves a caller-provided className alongside the variant class', () => {
    render(
      <Button variant="danger" className="extra-class">
        Delete
      </Button>
    )
    expect(screen.getByText('Delete')).toHaveClass('flare-button', 'flare-button--danger', 'extra-class')
  })
})
