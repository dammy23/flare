import { originalPositionFor, TraceMap } from '@jridgewell/trace-mapping'
import type { SentryEventItem } from '@flare/shared-types'
import type { StorageClient } from '@flare/storage'

type Exception = NonNullable<SentryEventItem['exception']>

export interface FrameCache {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
}

export interface ResolveFramesDeps {
  storage: Pick<StorageClient, 'getObject'>
  lookupArtifact: (filename: string) => Promise<{ storageKey: string } | null>
  cache: FrameCache
  releaseId: string
}

function cacheKey(releaseId: string, filename: string, lineno: number, colno: number): string {
  return `symcache:${releaseId}:${filename}:${lineno}:${colno}`
}

export async function resolveFrames(exception: Exception, deps: ResolveFramesDeps): Promise<Exception> {
  const traceMapCache = new Map<string, TraceMap>()

  for (const value of exception.values) {
    const frames = value.stacktrace?.frames
    if (!frames) continue

    for (const frame of frames) {
      if (frame.in_app === false || !frame.filename || frame.lineno === undefined || frame.colno === undefined) {
        continue
      }

      const key = cacheKey(deps.releaseId, frame.filename, frame.lineno, frame.colno)
      const cached = await deps.cache.get(key)
      if (cached) {
        const position = JSON.parse(cached) as {
          source: string | null
          line: number | null
          column: number | null
          name: string | null
        }
        if (position.source) {
          frame.filename = position.source
          frame.lineno = position.line ?? frame.lineno
          frame.colno = position.column ?? frame.colno
          if (position.name) frame.function = position.name
        }
        continue
      }

      const artifact = await deps.lookupArtifact(frame.filename)
      if (!artifact) continue

      let traceMap = traceMapCache.get(artifact.storageKey)
      if (!traceMap) {
        const mapContent = await deps.storage.getObject(artifact.storageKey)
        traceMap = new TraceMap(mapContent.toString('utf8'))
        traceMapCache.set(artifact.storageKey, traceMap)
      }

      const position = originalPositionFor(traceMap, { line: frame.lineno, column: frame.colno })
      await deps.cache.set(key, JSON.stringify(position))

      if (position.source) {
        frame.filename = position.source
        frame.lineno = position.line ?? frame.lineno
        frame.colno = position.column ?? frame.colno
        if (position.name) frame.function = position.name
      }
    }
  }

  return exception
}
