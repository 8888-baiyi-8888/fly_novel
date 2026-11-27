import { z } from 'zod'
import { sceneEventDigestSchema, type SceneEvent } from './scene-event.js'

const text = z.string().min(1)
const uuid = z.string().uuid()
const identity = { worldId: text, convoyId: uuid, digest: sceneEventDigestSchema }
export const currentConvoyEvidenceSchema = z.discriminatedUnion('status', [
  z.object({ ...identity, status: z.literal('arrived'), revision: z.literal(0) }).strict(),
  z.object({ ...identity, status: z.literal('waiting'), revision: z.literal(1), locationId: text,
    operationId: uuid, eventId: sceneEventDigestSchema }).strict(),
])
export type CurrentConvoyEvidence = z.infer<typeof currentConvoyEvidenceSchema>

export const eventEvidenceSchema = z.object({ eventId: sceneEventDigestSchema, storyId: uuid, sceneId: text,
  digest: sceneEventDigestSchema, outcomes: z.array(z.object({ sequence: z.number().int().positive(), index: z.number().int().nonnegative(),
    status: z.enum(['succeeded', 'blocked', 'unresolved']), observable: text.optional(), reason: text }).strict()),
}).strict()
export type EventEvidence = z.infer<typeof eventEvidenceSchema>

export const storyWorldEvidenceSchema = z.object({ current: currentConvoyEvidenceSchema, events: z.array(eventEvidenceSchema) }).strict()
  .refine(item => new Set(item.events.map(event => event.eventId)).size === item.events.length, '故事事件依据重复')
export type StoryWorldEvidence = z.infer<typeof storyWorldEvidenceSchema>

export interface StoryWorldProgressSource {
  readonly worldId: string
  readonly runId: string
  current(): Promise<CurrentConvoyEvidence>
  event(storyId: string, sceneId: string): Promise<EventEvidence>
}

export function eventAssessmentEvidence(event: SceneEvent, digest: string): EventEvidence {
  return { eventId: event.eventId, storyId: event.storyId, sceneId: event.sceneId, digest,
    outcomes: event.sequence.flatMap(item => item.actions.map(({ index, status, observable, reason }) => ({
      sequence: item.order, index, status, reason, ...(observable ? { observable } : {}),
    }))) }
}
