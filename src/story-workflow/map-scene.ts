import { z } from 'zod'

const uuid = z.string().uuid()
const text = z.string().trim().min(1)
export const mapSceneNeedSchema = z.object({ cityId: uuid, layerId: text, purpose: text }).strict()
export type MapSceneNeed = z.infer<typeof mapSceneNeedSchema>
const mapProof = z.object({ id: uuid, version: text }).strict()
export const mapSceneCheckSchema = z.object({
  formatVersion: z.literal(1), id: uuid, runId: uuid, storyId: uuid, worldId: text, need: mapSceneNeedSchema,
  result: z.discriminatedUnion('status', [
    z.object({ status: z.literal('ready'), city: mapProof, gate: mapProof, waiting: mapProof, snapshotVersion: text }).strict(),
    z.object({ status: z.literal('missing'), city: mapProof, gate: mapProof.optional(), snapshotVersion: text,
      missing: z.array(z.enum(['gate', 'waiting'])).min(1) }).strict(),
    z.object({ status: z.enum(['forbidden', 'failed', 'stale', 'uncovered']), reason: text }).strict(),
  ]),
}).strict()
export type MapSceneCheck = z.infer<typeof mapSceneCheckSchema>

const description = text.max(1500)
export const mapProposalAnswerSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('proposed'), cityId: uuid, layerId: text,
    gate: z.discriminatedUnion('kind', [z.object({ kind: z.literal('existing'), id: uuid }).strict(), z.object({ kind: z.literal('proposed'), description }).strict()]),
    waiting: z.object({ name: text.max(100), description, relativeToGate: description }).strict(),
  }).strict(),
  z.object({ status: z.literal('rejected'), reason: description }).strict(),
])
export const mapProposalKeySchema = z.object({ formatVersion: z.literal(1), runId: uuid, storyId: uuid, checkId: uuid }).strict()
export const mapProposalRecordSchema = mapProposalKeySchema.extend({ result: z.union([
  mapProposalAnswerSchema,
  z.object({ status: z.enum(['cancelled', 'timeout', 'failed', 'invalid']) }).strict(),
]) }).strict()
export type MapProposalRecord = z.infer<typeof mapProposalRecordSchema>
