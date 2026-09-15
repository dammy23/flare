import { describe, expect, it, vi } from 'vitest'
import { resolveFrames } from './resolve-frames'

// A minimal, hand-verified source map: generated line 1, column 0 maps
// to source 0 ("original.js"), original line 10, column 2.
// Segment [genCol=0, sourceIdx=0, origLine delta=9 (0-based), origCol=2]
// VLQ-encodes to "AASE" (A=0, A=0, S=18->9, E=4->2).
const TRIVIAL_MAP = JSON.stringify({
  version: 3,
  sources: ['original.js'],
  names: [],
  mappings: 'AASE',
  file: 'app.min.js',
})

describe('resolveFrames', () => {
  it('resolves an in-app frame using the matching uploaded source map', async () => {
    const storage = { getObject: vi.fn().mockResolvedValue(Buffer.from(TRIVIAL_MAP)) }
    const lookupArtifact = vi.fn().mockResolvedValue({ storageKey: 'releases/p1/1.0.0/app.min.js.map' })
    const cache = { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined) }

    const result = await resolveFrames(
      { values: [{ type: 'TypeError', stacktrace: { frames: [{ filename: 'app.min.js', lineno: 1, colno: 0, in_app: true }] } }] },
      { storage: storage as never, lookupArtifact, cache: cache as never, releaseId: 'release-1' }
    )

    const resolvedFrame = result.values[0].stacktrace!.frames![0]
    expect(resolvedFrame.filename).toBe('original.js')
    expect(resolvedFrame.lineno).toBe(10)
    expect(resolvedFrame.colno).toBe(2)
    expect(cache.set).toHaveBeenCalled()
  })

  it('leaves a frame unresolved (but does not throw) when no artifact matches', async () => {
    const storage = { getObject: vi.fn() }
    const lookupArtifact = vi.fn().mockResolvedValue(null)
    const cache = { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined) }

    const result = await resolveFrames(
      { values: [{ type: 'TypeError', stacktrace: { frames: [{ filename: 'unknown.js', lineno: 1, colno: 0, in_app: true }] } }] },
      { storage: storage as never, lookupArtifact, cache: cache as never, releaseId: 'release-1' }
    )

    expect(result.values[0].stacktrace!.frames![0].filename).toBe('unknown.js')
    expect(storage.getObject).not.toHaveBeenCalled()
  })

  it('uses the cached resolved position instead of re-fetching the map', async () => {
    const storage = { getObject: vi.fn() }
    const lookupArtifact = vi.fn().mockResolvedValue({ storageKey: 'releases/p1/1.0.0/app.min.js.map' })
    const cache = {
      get: vi.fn().mockResolvedValue(JSON.stringify({ source: 'original.js', line: 10, column: 2, name: 'main' })),
      set: vi.fn(),
    }

    const result = await resolveFrames(
      { values: [{ type: 'TypeError', stacktrace: { frames: [{ filename: 'app.min.js', lineno: 1, colno: 0, in_app: true }] } }] },
      { storage: storage as never, lookupArtifact, cache: cache as never, releaseId: 'release-1' }
    )

    expect(result.values[0].stacktrace!.frames![0].filename).toBe('original.js')
    expect(storage.getObject).not.toHaveBeenCalled()
  })

  it('skips frames marked in_app: false', async () => {
    const storage = { getObject: vi.fn() }
    const lookupArtifact = vi.fn()
    const cache = { get: vi.fn(), set: vi.fn() }

    const result = await resolveFrames(
      { values: [{ type: 'TypeError', stacktrace: { frames: [{ filename: 'vendor.js', lineno: 1, colno: 0, in_app: false }] } }] },
      { storage: storage as never, lookupArtifact, cache: cache as never, releaseId: 'release-1' }
    )

    expect(result.values[0].stacktrace!.frames![0].filename).toBe('vendor.js')
    expect(lookupArtifact).not.toHaveBeenCalled()
  })
})
