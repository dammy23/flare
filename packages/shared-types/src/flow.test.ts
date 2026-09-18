import { describe, expect, it } from 'vitest'
import { FlowCheckpointSchema } from './flow'

describe('FlowCheckpointSchema', () => {
  it('parses a minimal checkpoint and defaults status to ok', () => {
    const result = FlowCheckpointSchema.parse({
      stage: 'received',
      system: 'Dynamics',
      entityIds: [{ system: 'Dynamics', entityId: 'WO-123' }],
      dedupKey: 'dynamics:WO-123:received',
      occurredAt: '2026-09-18T12:00:00.000Z',
    })

    expect(result.status).toBe('ok')
    expect(result.entityIds).toHaveLength(1)
    expect(result.techTraceId).toBeUndefined()
  })

  it('parses a checkpoint with a translation and optional trace/issue links', () => {
    const result = FlowCheckpointSchema.parse({
      stage: 'mastered',
      system: 'MDM',
      entityIds: [
        { system: 'Dynamics', entityId: 'WO-123' },
        { system: 'MDM', entityId: 'MASTER-456' },
      ],
      dedupKey: 'mdm:MASTER-456:mastered',
      occurredAt: '2026-09-18T12:05:00.000Z',
      techTraceId: 'trace-abc',
      issueId: null,
      status: 'error',
    })

    expect(result.entityIds).toHaveLength(2)
    expect(result.techTraceId).toBe('trace-abc')
    expect(result.status).toBe('error')
  })

  it('rejects an empty entityIds array', () => {
    expect(() =>
      FlowCheckpointSchema.parse({
        stage: 'received',
        system: 'Dynamics',
        entityIds: [],
        dedupKey: 'x',
        occurredAt: '2026-09-18T12:00:00.000Z',
      })
    ).toThrow()
  })
})
