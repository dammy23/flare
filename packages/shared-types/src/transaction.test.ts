import { describe, expect, it } from 'vitest'
import { TransactionItemSchema } from './transaction'

describe('TransactionItemSchema', () => {
  it('parses a minimal transaction item with one span', () => {
    const result = TransactionItemSchema.parse({
      event_id: 'evt-1',
      transaction: 'GET /api/widgets',
      start_timestamp: 1700000000,
      timestamp: 1700000000.25,
      environment: 'production',
      contexts: { trace: { trace_id: 'a'.repeat(32), span_id: 'b'.repeat(16), op: 'http.server', status: 'ok' } },
      spans: [
        {
          span_id: 'c'.repeat(16),
          parent_span_id: 'b'.repeat(16),
          op: 'db.query',
          description: 'SELECT * FROM widgets',
          start_timestamp: 1700000000.05,
          timestamp: 1700000000.1,
        },
      ],
    })

    expect(result.transaction).toBe('GET /api/widgets')
    expect(result.contexts.trace.trace_id).toHaveLength(32)
    expect(result.spans).toHaveLength(1)
  })

  it('defaults spans to an empty array when absent', () => {
    const result = TransactionItemSchema.parse({
      event_id: 'evt-2',
      transaction: 'GET /health',
      start_timestamp: 1700000000,
      timestamp: 1700000000.01,
      contexts: { trace: { trace_id: 'd'.repeat(32), span_id: 'e'.repeat(16) } },
    })
    expect(result.spans).toEqual([])
  })
})
