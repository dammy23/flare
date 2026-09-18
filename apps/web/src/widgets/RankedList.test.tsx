import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { RankedList } from './RankedList'

describe('RankedList', () => {
  it('renders each issue with its count, preferring env_times_seen over times_seen', () => {
    render(
      <MemoryRouter>
        <RankedList
          data={[
            { id: 'issue-1', title: 'TypeError: boom', culprit: null, times_seen: 10, env_times_seen: 3 },
            { id: 'issue-2', title: 'RangeError: oops', culprit: null, times_seen: 7 },
          ]}
          projectId="proj-1"
        />
      </MemoryRouter>
    )

    expect(screen.getByText('TypeError: boom')).toBeInTheDocument()
    expect(screen.getByText('— 3')).toBeInTheDocument()
    expect(screen.getByText('RangeError: oops')).toBeInTheDocument()
    expect(screen.getByText('— 7')).toBeInTheDocument()
    expect(screen.getByText('TypeError: boom').closest('a')).toHaveAttribute(
      'href',
      '/issues/issue-1?projectId=proj-1'
    )
  })

  it('renders an empty-state message when there are no issues', () => {
    render(
      <MemoryRouter>
        <RankedList data={[]} projectId="proj-1" />
      </MemoryRouter>
    )
    expect(screen.getByText('No issues in this window')).toBeInTheDocument()
  })
})
