import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { fetchIssue, fetchIssues } from './query-client'

const server = setupServer(
  http.get('http://localhost:3001/api/v1/projects/proj-1/issues', () =>
    HttpResponse.json([
      { id: 'issue-1', title: 'TypeError: boom', culprit: null, status: 'unresolved', timesSeen: 3, firstSeen: '2026-09-01T00:00:00.000Z', lastSeen: '2026-09-15T00:00:00.000Z' },
    ])
  ),
  http.get('http://localhost:3001/api/v1/issues/issue-1', () =>
    HttpResponse.json({
      id: 'issue-1',
      title: 'TypeError: boom',
      culprit: null,
      status: 'unresolved',
      timesSeen: 3,
      firstSeen: '2026-09-01T00:00:00.000Z',
      lastSeen: '2026-09-15T00:00:00.000Z',
      events: [],
    })
  )
)

beforeAll(() => server.listen())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('fetchIssues', () => {
  it('returns the parsed issue list', async () => {
    const issues = await fetchIssues('proj-1')
    expect(issues).toHaveLength(1)
    expect(issues[0].title).toBe('TypeError: boom')
  })
})

describe('fetchIssue', () => {
  it('returns issue detail', async () => {
    const issue = await fetchIssue('issue-1', 'proj-1')
    expect(issue.id).toBe('issue-1')
    expect(issue.events).toEqual([])
  })
})
