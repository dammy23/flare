import { describe, expect, it } from 'vitest'
import { IssueDetailSchema, IssueSummarySchema } from './issue'

describe('IssueSummarySchema', () => {
  it('accepts a minimal issue summary', () => {
    const result = IssueSummarySchema.parse({
      id: 'issue-1',
      title: 'TypeError: boom',
      culprit: 'app.js in main',
      status: 'unresolved',
      timesSeen: 3,
      firstSeen: '2026-09-01T00:00:00.000Z',
      lastSeen: '2026-09-15T00:00:00.000Z',
    })
    expect(result.status).toBe('unresolved')
  })

  it('rejects an invalid status', () => {
    expect(() =>
      IssueSummarySchema.parse({
        id: 'issue-1',
        title: 'x',
        culprit: null,
        status: 'archived',
        timesSeen: 1,
        firstSeen: '2026-09-01T00:00:00.000Z',
        lastSeen: '2026-09-01T00:00:00.000Z',
      })
    ).toThrow()
  })
})

describe('IssueDetailSchema', () => {
  it('extends the summary with a list of recent events', () => {
    const result = IssueDetailSchema.parse({
      id: 'issue-1',
      title: 'TypeError: boom',
      culprit: null,
      status: 'unresolved',
      timesSeen: 1,
      firstSeen: '2026-09-01T00:00:00.000Z',
      lastSeen: '2026-09-01T00:00:00.000Z',
      events: [
        {
          id: 'event-1',
          timestamp: '2026-09-01T00:00:00.000Z',
          message: 'boom',
          exception: { values: [] },
        },
      ],
    })
    expect(result.events).toHaveLength(1)
  })
})
