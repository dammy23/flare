import { z } from 'zod'

export const WidgetTypeSchema = z.enum([
  'issues_over_time',
  'top_issues',
  'new_issues',
  'events_by_environment',
  'transaction_latency',
  'replay_count',
  'flows_by_stage',
])
export type WidgetType = z.infer<typeof WidgetTypeSchema>

export const IssuesOverTimeConfigSchema = z.object({
  days: z.number().int().positive().max(90).default(14),
})
export const TopIssuesConfigSchema = z.object({
  limit: z.number().int().positive().max(50).default(10),
  windowDays: z.number().int().positive().max(90).default(14),
})
export const NewIssuesConfigSchema = z.object({
  windowDays: z.number().int().positive().max(90).default(14),
})
export const EventsByEnvironmentConfigSchema = z.object({
  windowDays: z.number().int().positive().max(90).default(14),
})
export const TransactionLatencyConfigSchema = z.object({
  transactionName: z.string().default(''),
  hours: z.number().int().positive().max(168).default(24),
})
export const ReplayCountConfigSchema = z.object({
  windowDays: z.number().int().positive().max(90).default(14),
})
export const FlowsByStageConfigSchema = z.object({})

export const WidgetConfigSchemaByType = {
  issues_over_time: IssuesOverTimeConfigSchema,
  top_issues: TopIssuesConfigSchema,
  new_issues: NewIssuesConfigSchema,
  events_by_environment: EventsByEnvironmentConfigSchema,
  transaction_latency: TransactionLatencyConfigSchema,
  replay_count: ReplayCountConfigSchema,
  flows_by_stage: FlowsByStageConfigSchema,
} as const

export type WidgetConfigFor<T extends WidgetType> = z.infer<(typeof WidgetConfigSchemaByType)[T]>

export function validateWidgetConfig<T extends WidgetType>(type: T, config: unknown): WidgetConfigFor<T> {
  return WidgetConfigSchemaByType[type].parse(config) as WidgetConfigFor<T>
}

export const WidgetLayoutSchema = z.object({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  w: z.number().int().min(1).max(12),
  h: z.number().int().min(1).max(12),
})
export type WidgetLayout = z.infer<typeof WidgetLayoutSchema>

export const WidgetEnvironmentModeSchema = z.enum(['inherit', 'pin'])
export type WidgetEnvironmentMode = z.infer<typeof WidgetEnvironmentModeSchema>

export const WidgetSchema = z.object({
  id: z.string(),
  widgetType: WidgetTypeSchema,
  title: z.string(),
  layout: WidgetLayoutSchema,
  config: z.unknown(),
  environmentMode: WidgetEnvironmentModeSchema,
  pinnedEnvironmentName: z.string().nullable(),
})
export type Widget = z.infer<typeof WidgetSchema>

export const DashboardSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  envSelectorDefault: z.string().nullable(),
  widgets: z.array(WidgetSchema),
})
export type Dashboard = z.infer<typeof DashboardSchema>
