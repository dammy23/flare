import type { Kysely } from 'kysely'
import type { Database } from '@flare/db'
import { attachOrCreateFlowTrace, upsertFlowStep } from '@flare/db'
import { FlowCheckpointSchema } from '@flare/shared-types'

interface IngestFlowMessage {
  projectId: string
  checkpoint: unknown
}

export async function handleFlowCheckpointMessage(db: Kysely<Database>, data: unknown): Promise<void> {
  const message = data as IngestFlowMessage
  const checkpoint = FlowCheckpointSchema.parse(message.checkpoint)

  const flowTraceId = await attachOrCreateFlowTrace(db, {
    projectId: message.projectId,
    reportedIds: checkpoint.entityIds,
  })

  await upsertFlowStep(db, {
    flowTraceId,
    stageName: checkpoint.stage,
    system: checkpoint.system,
    dedupKey: checkpoint.dedupKey,
    reportedIds: checkpoint.entityIds,
    techTraceId: checkpoint.techTraceId ?? null,
    issueId: checkpoint.issueId ?? null,
    occurredAt: new Date(checkpoint.occurredAt),
    status: checkpoint.status,
  })
}
