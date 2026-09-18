import { z } from 'zod'

export const FlowEntityIdSchema = z.object({
  system: z.string(),
  entityId: z.string(),
})
export type FlowEntityId = z.infer<typeof FlowEntityIdSchema>

export const FlowCheckpointSchema = z.object({
  stage: z.string(),
  system: z.string(),
  entityIds: z.array(FlowEntityIdSchema).min(1),
  dedupKey: z.string(),
  occurredAt: z.string().datetime(),
  techTraceId: z.string().nullable().optional(),
  issueId: z.string().nullable().optional(),
  status: z.enum(['ok', 'error']).default('ok'),
})
export type FlowCheckpoint = z.infer<typeof FlowCheckpointSchema>
