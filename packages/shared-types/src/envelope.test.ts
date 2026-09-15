import { describe, expect, it } from 'vitest'
import { EnvelopeHeaderSchema, ItemHeaderSchema, SentryEventItemSchema } from './envelope'

describe('EnvelopeHeaderSchema', () => {
  it('accepts a header with only event_id', () => {
    const result = EnvelopeHeaderSchema.parse({ event_id: '9ec79c33-1d6e-4c1d-8a7e-000000000000' })
    expect(result.event_id).toBe('9ec79c33-1d6e-4c1d-8a7e-000000000000')
  })
})

describe('ItemHeaderSchema', () => {
  it('accepts a known item type without length', () => {
    const result = ItemHeaderSchema.parse({ type: 'event' })
    expect(result.type).toBe('event')
  })

  it('rejects an unknown item type', () => {
    expect(() => ItemHeaderSchema.parse({ type: 'not_a_real_type' })).toThrow()
  })
})

describe('SentryEventItemSchema', () => {
  it('defaults environment to production when absent', () => {
    const result = SentryEventItemSchema.parse({
      event_id: 'abc123',
      exception: { values: [{ type: 'Error', value: 'boom' }] },
    })
    expect(result.environment).toBe('production')
  })

  it('accepts a full stacktrace with in_app frames', () => {
    const result = SentryEventItemSchema.parse({
      event_id: 'abc123',
      environment: 'staging',
      exception: {
        values: [
          {
            type: 'TypeError',
            value: "Cannot read properties of undefined (reading 'x')",
            stacktrace: {
              frames: [
                { filename: 'app.js', function: 'main', lineno: 10, colno: 3, in_app: true },
              ],
            },
          },
        ],
      },
    })
    expect(result.exception?.values[0]?.stacktrace?.frames?.[0]?.in_app).toBe(true)
  })
})
