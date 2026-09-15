import { z } from 'zod'

export const EnvelopeHeaderSchema = z.object({
  event_id: z.string().optional(),
  dsn: z.string().optional(),
  sent_at: z.string().optional(),
})
export type EnvelopeHeader = z.infer<typeof EnvelopeHeaderSchema>

export const ItemHeaderSchema = z.object({
  type: z.enum([
    'event',
    'transaction',
    'replay_event',
    'replay_recording',
    'attachment',
    'session',
    'client_report',
  ]),
  length: z.number().int().nonnegative().optional(),
  content_type: z.string().optional(),
})
export type ItemHeader = z.infer<typeof ItemHeaderSchema>

const StackFrameSchema = z.object({
  filename: z.string().optional(),
  function: z.string().optional(),
  lineno: z.number().optional(),
  colno: z.number().optional(),
  in_app: z.boolean().optional(),
})

const ExceptionValueSchema = z.object({
  type: z.string().optional(),
  value: z.string().optional(),
  stacktrace: z.object({ frames: z.array(StackFrameSchema).optional() }).optional(),
})

export const SentryEventItemSchema = z.object({
  event_id: z.string(),
  timestamp: z.union([z.number(), z.string()]).optional(),
  environment: z.string().default('production'),
  level: z.string().optional(),
  message: z.string().optional(),
  exception: z.object({ values: z.array(ExceptionValueSchema) }).optional(),
})
export type SentryEventItem = z.infer<typeof SentryEventItemSchema>
