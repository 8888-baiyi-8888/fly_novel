import { createHash } from 'node:crypto'
import { z } from 'zod'
import { characterResponseSchema, type CharacterResponse } from './character-participation.js'

const id = z.string().uuid()
const text = z.string().trim().min(1).max(4000)
const channelAccess = z.enum(['clear', 'partial', 'blocked', 'unknown'])
export const sceneInteractionConditionsSchema = z.object({ version: text, participants: z.array(z.object({
  characterId: id, position: text, hearing: channelAccess, sight: channelAccess, basis: text,
  initiative: z.object({ id: text, description: text }).strict().optional(),
}).strict()).min(1).max(16) }).strict().refine(value => new Set(value.participants.map(item => item.characterId)).size === value.participants.length, '场景参与角色重复')
export type SceneInteractionConditions = z.infer<typeof sceneInteractionConditionsSchema>
const speech = z.object({ text, channel: z.enum(['normal', 'whisper']), intendedCharacterIds: z.array(id).max(16) }).strict()
export const sceneInteractionEventSchema = z.object({
  formatVersion: z.literal(1), runId: id, storyId: id, sceneId: text, sequence: z.number().int().positive().max(10000),
  setupDigest: z.string().regex(/^[a-f0-9]{64}$/), participationId: id, characterId: id, conditions: sceneInteractionConditionsSchema,
  speech: z.array(speech).max(8), actions: z.array(text).max(8), responseKind: z.enum(['respond', 'wait', 'decline']),
}).strict().refine(value => value.conditions.participants.some(item => item.characterId === value.characterId), '发出者不在场景参与者中')
export type SceneInteractionEvent = z.infer<typeof sceneInteractionEventSchema>

export function sceneInteractionDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function visibleCharacterResponse(response: CharacterResponse) {
  const value = characterResponseSchema.parse(response)
  return { responseKind: value.kind, speech: value.kind === 'respond' ? value.speech : [], actions: value.kind === 'respond' ? value.actions : [] }
}

const observationReference = z.object({ kind: z.literal('speech'), index: z.number().int().nonnegative(),
  range: z.tuple([z.number().int().nonnegative(), z.number().int().positive()]).optional(),
}).strict()
const perception = z.object({ characterId: id, status: z.enum(['received', 'partial', 'not-received', 'uncertain']),
  reason: text, observations: z.array(observationReference).max(8),
}).strict()
const next = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('respond'), characterId: id, trigger: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('observation'), index: z.number().int().nonnegative() }).strict(),
    z.object({ kind: z.literal('initiative'), id: text }).strict(),
  ]) }).strict(),
  z.object({ kind: z.enum(['wait', 'review', 'end']), reason: text }).strict(),
])
export const sceneInteractionDecisionInputSchema = z.object({ perceptions: z.array(perception).max(16), next }).strict()
export const sceneInteractionDecisionSchema = sceneInteractionDecisionInputSchema.extend({
  formatVersion: z.literal(1), sequence: z.number().int().positive(), eventDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
export type SceneInteractionDecision = z.infer<typeof sceneInteractionDecisionSchema>

/** 核对所有投递引用与调度依据，并从原发言截取实际文本。 */
export function resolveInteractionPerceptions(event: SceneInteractionEvent, input: z.infer<typeof sceneInteractionDecisionInputSchema>) {
  const actors = new Map(event.conditions.participants.map(item => [item.characterId, item]))
  const perceptions = new Map(input.perceptions.map(item => [item.characterId, item]))
  if (perceptions.size !== actors.size || perceptions.size !== input.perceptions.length || [...actors.keys()].some(id => !perceptions.has(id))) {
    throw new Error('感知判定未逐一覆盖场景参与者')
  }
  const resolved = input.perceptions.map(({ characterId, status, observations, reason }) => {
    const actor = actors.get(characterId)!
    if (['not-received', 'uncertain'].includes(status) ? observations.length !== 0 : observations.length === 0) throw new Error('感知状态与投递内容不匹配')
    if (actor.hearing === 'unknown' && event.speech.length && status === 'not-received') throw new Error('听闻条件待确认')
    const seen = new Set<number>()
    const content = observations.map(reference => {
      const original = event.speech[reference.index]
      if (!original || seen.has(reference.index)) throw new Error('感知引用缺失或重复')
      seen.add(reference.index)
      if (actor.hearing === 'blocked' || actor.hearing === 'unknown') throw new Error('角色听不到所选发言')
      const range = reference.range ?? [0, original.text.length]
      const [start, end] = range
      if (start >= end || end > original.text.length) throw new Error('原话片段越界')
      const partial = end - start < original.text.length
      if ((actor.hearing === 'partial' || status === 'partial') && !partial) throw new Error('部分听见须使用原话片段')
      if (status === 'received' && partial) throw new Error('完整收到的发言不能截断')
      return { ...reference, content: original.text.slice(start, end) }
    })
    return { characterId, status, reason, basis: actor.basis, observations: content }
  })
  if (input.next.kind === 'respond') {
    const { characterId, trigger } = input.next
    if (!actors.has(characterId) || (trigger.kind === 'observation'
      ? !resolved.find(item => item.characterId === characterId)?.observations[trigger.index]
      : actors.get(characterId)?.initiative?.id !== trigger.id)) throw new Error('下一位回应者缺少可用触发依据')
  }
  return resolved
}
