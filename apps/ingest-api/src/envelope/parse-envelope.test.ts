import { describe, expect, it } from 'vitest'
import { parseEnvelope } from './parse-envelope'

function envelopeBuffer(lines: (string | Buffer)[]): Buffer {
  return Buffer.concat(
    lines.map((line) => (Buffer.isBuffer(line) ? Buffer.concat([line, Buffer.from('\n')]) : Buffer.from(line + '\n')))
  )
}

describe('parseEnvelope', () => {
  it('parses a single event item with explicit length', () => {
    const payload = JSON.stringify({ event_id: 'abc', exception: { values: [] } })
    const raw = envelopeBuffer([
      JSON.stringify({ event_id: 'abc' }),
      JSON.stringify({ type: 'event', length: Buffer.byteLength(payload) }),
      payload,
    ])

    const result = parseEnvelope(raw)

    expect(result.header.event_id).toBe('abc')
    expect(result.items).toHaveLength(1)
    expect(result.items[0].header.type).toBe('event')
    expect(JSON.parse(result.items[0].payload.toString('utf8'))).toEqual({
      event_id: 'abc',
      exception: { values: [] },
    })
  })

  it('parses an item with no explicit length by reading to the next newline', () => {
    const raw = envelopeBuffer([
      JSON.stringify({ event_id: 'no-length' }),
      JSON.stringify({ type: 'event' }),
      JSON.stringify({ event_id: 'no-length', exception: { values: [] } }),
    ])

    const result = parseEnvelope(raw)
    expect(result.items).toHaveLength(1)
    expect(JSON.parse(result.items[0].payload.toString('utf8')).event_id).toBe('no-length')
  })

  it('parses multiple items, including one with a binary payload containing newlines', () => {
    const binaryPayload = Buffer.from([0x01, 0x0a, 0x02, 0x0a, 0x03])
    const eventPayload = JSON.stringify({ event_id: 'multi', exception: { values: [] } })
    const raw = envelopeBuffer([
      JSON.stringify({ event_id: 'multi' }),
      JSON.stringify({ type: 'event', length: Buffer.byteLength(eventPayload) }),
      eventPayload,
      JSON.stringify({ type: 'attachment', length: binaryPayload.length }),
      binaryPayload,
    ])

    const result = parseEnvelope(raw)
    expect(result.items).toHaveLength(2)
    expect(result.items[1].header.type).toBe('attachment')
    expect(result.items[1].payload.equals(binaryPayload)).toBe(true)
  })
})
