import { z } from 'zod'

export const IssueStatusSchema = z.enum(['unresolved', 'resolved', 'ignored'])
export type IssueStatus = z.infer<typeof IssueStatusSchema>

export const IssueSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  culprit: z.string().nullable(),
  status: IssueStatusSchema,
  timesSeen: z.number().int().nonnegative(),
  firstSeen: z.string(),
  lastSeen: z.string(),
})
export type IssueSummary = z.infer<typeof IssueSummarySchema>

export const IssueEventSchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  message: z.string().nullable(),
  exception: z.unknown(),
})
export type IssueEvent = z.infer<typeof IssueEventSchema>

export const IssueDetailSchema = IssueSummarySchema.extend({
  events: z.array(IssueEventSchema),
})
export type IssueDetail = z.infer<typeof IssueDetailSchema>
