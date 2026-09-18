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

  it('carries an optional release string', () => {
    const result = SentryEventItemSchema.parse({ event_id: 'abc', release: 'my-app@1.2.3' })
    expect(result.release).toBe('my-app@1.2.3')
  })

  it('accepts breadcrumbs with a category, message, level, and timestamp', () => {
    const result = SentryEventItemSchema.parse({
      event_id: 'abc123',
      breadcrumbs: {
        values: [
          { type: 'http', category: 'fetch', message: 'GET /api/widgets', level: 'info', timestamp: 1700000000 },
          { category: 'ui.click', message: 'button#submit', level: 'info', timestamp: 1700000001 },
        ],
      },
    })
    expect(result.breadcrumbs?.values).toHaveLength(2)
    expect(result.breadcrumbs?.values[0]?.category).toBe('fetch')
  })

  it('defaults breadcrumbs to undefined when absent', () => {
    const result = SentryEventItemSchema.parse({ event_id: 'abc123' })
    expect(result.breadcrumbs).toBeUndefined()
  })
})
