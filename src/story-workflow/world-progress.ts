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

export const worldObjectiveSchema = z.object({ id: text, description: text, criterion: z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('convoy-waiting') }).strict(),
  z.object({ kind: z.literal('confirmed-action'), observable: text }).strict(),
]) }).strict()
export const worldObjectivesSchema = z.array(worldObjectiveSchema).min(1).max(16)
  .refine(items => new Set(items.map(item => item.id)).size === items.length, '故事评估目标重复')
export type WorldObjective = z.infer<typeof worldObjectiveSchema>

const objectiveFindingSchema = z.object({ objective: worldObjectiveSchema, evidence: z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('state'), eventId: sceneEventDigestSchema, operationId: uuid, digest: sceneEventDigestSchema }).strict(),
  z.object({ kind: z.literal('action'), eventId: sceneEventDigestSchema, sequence: z.number().int().positive(), index: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal('unmet') }).strict(),
]) }).strict()

export const storyWorldEvidenceSchema = z.object({ current: currentConvoyEvidenceSchema, events: z.array(eventEvidenceSchema),
  objectives: z.array(objectiveFindingSchema).min(1).max(16).optional() }).strict()
  .refine(item => new Set(item.events.map(event => event.eventId)).size === item.events.length, '故事事件依据重复')
export type StoryWorldEvidence = z.infer<typeof storyWorldEvidenceSchema>

export function evaluateWorldObjectives(input: Pick<StoryWorldEvidence, 'current' | 'events'>, objectives: readonly WorldObjective[]): NonNullable<StoryWorldEvidence['objectives']> {
  return objectives.map(objective => {
    const { current, events } = input
    const { criterion } = objective
    if (criterion.kind === 'convoy-waiting' && current.status === 'waiting' && events.some(event => event.eventId === current.eventId)) {
      return { objective, evidence: { kind: 'state', eventId: current.eventId, operationId: current.operationId, digest: current.digest } }
    }
    if (criterion.kind === 'confirmed-action') {
      for (const event of events) {
        const match = event.outcomes.find(action => action.status === 'succeeded' && action.observable === criterion.observable)
        if (match) return { objective, evidence: { kind: 'action', eventId: event.eventId, sequence: match.sequence, index: match.index } }
      }
    }
    return { objective, evidence: { kind: 'unmet' } }
  })
}

export function verifyWorldAssessment(status: 'achieved' | 'unmet' | 'terminated' | 'supplement', evidence?: StoryWorldEvidence): void {
  const findings = evidence?.objectives
  if (findings && status !== 'terminated' && (status === 'achieved') !== findings.every(item => item.evidence.kind !== 'unmet')) {
    throw new Error('父导演的评估或补充与目标证据不一致')
  }
}

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
