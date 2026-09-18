import { z } from 'zod'

export const ReplayEventItemSchema = z.object({
  event_id: z.string(),
  replay_id: z.string(),
  segment_id: z.number().int().nonnegative(),
  environment: z.string().default('production'),
  timestamp: z.number(),
  error_ids: z.array(z.string()).default([]),
})
export type ReplayEventItem = z.infer<typeof ReplayEventItemSchema>
