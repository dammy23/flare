import { describe, expect, it } from 'vitest'
import { parseSentryAuthHeader } from './parse-sentry-auth-header'

describe('parseSentryAuthHeader', () => {
  it('extracts sentry_key from a standard header', () => {
    const header = 'Sentry sentry_version=7, sentry_key=abc123, sentry_client=sentry.javascript.node/8.0.0'
    expect(parseSentryAuthHeader(header)).toBe('abc123')
  })

  it('returns null when the header is missing', () => {
    expect(parseSentryAuthHeader(undefined)).toBeNull()
  })

  it('returns null when sentry_key is absent', () => {
    expect(parseSentryAuthHeader('Sentry sentry_version=7')).toBeNull()
  })
})
