import { EnvelopeHeaderSchema, ItemHeaderSchema, type EnvelopeHeader, type ItemHeader } from '@flare/shared-types'

export interface ParsedEnvelopeItem {
  header: ItemHeader
  payload: Buffer
}

export interface ParsedEnvelope {
  header: EnvelopeHeader
  items: ParsedEnvelopeItem[]
}

function readLine(buffer: Buffer, offset: number): { line: Buffer; nextOffset: number } {
  const newlineIndex = buffer.indexOf(0x0a, offset)
  if (newlineIndex === -1) {
    return { line: buffer.subarray(offset), nextOffset: buffer.length }
  }
  return { line: buffer.subarray(offset, newlineIndex), nextOffset: newlineIndex + 1 }
}

export function parseEnvelope(raw: Buffer): ParsedEnvelope {
  let offset = 0

  const headerLine = readLine(raw, offset)
  const header = EnvelopeHeaderSchema.parse(JSON.parse(headerLine.line.toString('utf8')))
  offset = headerLine.nextOffset

  const items: ParsedEnvelopeItem[] = []

  while (offset < raw.length) {
    const itemHeaderLine = readLine(raw, offset)
    if (itemHeaderLine.line.length === 0) {
      offset = itemHeaderLine.nextOffset
      continue
    }
    const itemHeader = ItemHeaderSchema.parse(JSON.parse(itemHeaderLine.line.toString('utf8')))
    offset = itemHeaderLine.nextOffset

    let payload: Buffer
    if (typeof itemHeader.length === 'number') {
      payload = raw.subarray(offset, offset + itemHeader.length)
      offset += itemHeader.length
      if (raw[offset] === 0x0a) offset += 1
    } else {
      const payloadLine = readLine(raw, offset)
      payload = Buffer.from(payloadLine.line)
      offset = payloadLine.nextOffset
    }

    items.push({ header: itemHeader, payload })
  }

  return { header, items }
}
