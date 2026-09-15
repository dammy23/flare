import { describe, expect, it } from 'vitest'
import { computeFingerprint } from './fingerprint'

describe('computeFingerprint', () => {
  it('produces the same fingerprint for the same top in-app frames', () => {
    const exceptionA = {
      values: [
        {
          type: 'TypeError',
          stacktrace: {
            frames: [
              { filename: 'a.js', function: 'helper', in_app: false },
              { filename: 'app.js', function: 'main', in_app: true },
              { filename: 'app.js', function: 'handler', in_app: true },
            ],
          },
        },
      ],
    }
    const exceptionB = {
      values: [
        {
          type: 'TypeError',
          stacktrace: {
            frames: [
              { filename: 'app.js', function: 'main', in_app: true },
              { filename: 'app.js', function: 'handler', in_app: true },
            ],
          },
        },
      ],
    }

    expect(computeFingerprint(exceptionA)).toBe(computeFingerprint(exceptionB))
  })

  it('produces different fingerprints for different exception types', () => {
    const base = { stacktrace: { frames: [{ filename: 'app.js', function: 'main', in_app: true }] } }
    const fpA = computeFingerprint({ values: [{ type: 'TypeError', ...base }] })
    const fpB = computeFingerprint({ values: [{ type: 'RangeError', ...base }] })
    expect(fpA).not.toBe(fpB)
  })

  it('falls back to a stable fingerprint when there is no exception', () => {
    expect(computeFingerprint(undefined)).toBe(computeFingerprint(undefined))
  })
})
