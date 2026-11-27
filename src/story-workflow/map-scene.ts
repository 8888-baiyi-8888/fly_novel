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
