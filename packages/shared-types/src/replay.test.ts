import { describe, expect, it } from 'vitest'
import { ReplayEventItemSchema } from './replay'

describe('ReplayEventItemSchema', () => {
  it('parses a minimal replay_event item', () => {
    const result = ReplayEventItemSchema.parse({
      event_id: 'evt-1',
      replay_id: 'replay-1',
      segment_id: 0,
      environment: 'production',
      timestamp: 1700000000,
    })
    expect(result.replay_id).toBe('replay-1')
    expect(result.segment_id).toBe(0)
  })

  it('defaults error_ids to an empty array and environment to production', () => {
    const result = ReplayEventItemSchema.parse({
      event_id: 'evt-2',
      replay_id: 'replay-2',
      segment_id: 1,
      timestamp: 1700000000,
    })
    expect(result.error_ids).toEqual([])
    expect(result.environment).toBe('production')
  })
})
