import { z } from 'zod'

const SpanSchema = z.object({
  span_id: z.string(),
  parent_span_id: z.string().optional(),
  op: z.string().optional(),
  description: z.string().optional(),
  start_timestamp: z.number(),
  timestamp: z.number(),
})

export const TransactionItemSchema = z.object({
  event_id: z.string(),
  transaction: z.string(),
  environment: z.string().default('production'),
  release: z.string().optional(),
  start_timestamp: z.number(),
  timestamp: z.number(),
  contexts: z.object({
    trace: z.object({
      trace_id: z.string(),
      span_id: z.string(),
      op: z.string().optional(),
      status: z.string().optional(),
    }),
  }),
  spans: z.array(SpanSchema).default([]),
})
export type TransactionItem = z.infer<typeof TransactionItemSchema>
