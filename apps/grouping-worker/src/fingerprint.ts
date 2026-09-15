import { createHash } from 'node:crypto'
import type { SentryEventItem } from '@flare/shared-types'

const TOP_N_FRAMES = 5

export function computeFingerprint(exception: SentryEventItem['exception']): string {
  const primary = exception?.values?.[0]
  if (!primary) {
    return createHash('sha1').update('no-exception').digest('hex')
  }

  const inAppFrames = (primary.stacktrace?.frames ?? [])
    .filter((frame) => frame.in_app !== false)
    .slice(-TOP_N_FRAMES)
    .map((frame) => `${frame.filename ?? ''}:${frame.function ?? ''}`)

  const basis = [primary.type ?? '', ...inAppFrames].join('|')
  return createHash('sha1').update(basis).digest('hex')
}
