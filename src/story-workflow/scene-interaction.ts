import { createHash } from 'node:crypto'
import { z } from 'zod'
import { characterResponseSchema, type CharacterResponse } from './character-participation.js'

const id = z.string().uuid()
const text = z.string().trim().min(1).max(4000)
const channelAccess = z.enum(['clear', 'partial', 'blocked', 'unknown'])
const speechHearing = z.array(z.object({ index: z.number().int().nonnegative(), access: channelAccess, basis: text }).strict()).max(8)
  .refine(items => new Set(items.map(item => item.index)).size === items.length, '发言听闻条件重复')
export const sceneInteractionConditionsSchema = z.object({ version: text, participants: z.array(z.object({
  characterId: id, position: text, hearing: channelAccess, sight: channelAccess, basis: text,
  speechHearing: speechHearing.optional(),
  initiative: z.object({ id: text, description: text }).strict().optional(),
}).strict()).min(1).max(16) }).strict().refine(value => new Set(value.participants.map(item => item.characterId)).size === value.participants.length, '场景参与角色重复')
export type SceneInteractionConditions = z.infer<typeof sceneInteractionConditionsSchema>
const speech = z.object({ text, channel: z.enum(['normal', 'whisper']), intendedCharacterIds: z.array(id).max(16) }).strict()
export const sceneInteractionEventSchema = z.object({
  formatVersion: z.literal(1), runId: id, storyId: id, sceneId: text, sequence: z.number().int().positive().max(10000),
  setupDigest: z.string().regex(/^[a-f0-9]{64}$/), participationId: id, characterId: id, conditions: sceneInteractionConditionsSchema,
  speech: z.array(speech).max(8), actions: z.array(text).max(8), responseKind: z.enum(['respond', 'wait', 'decline']),
}).strict().refine(value => value.conditions.participants.some(item => item.characterId === value.characterId), '发出者不在场景参与者中')
  .refine(value => value.conditions.participants.every(item => item.speechHearing?.every(entry => entry.index < value.speech.length) ?? true), '听闻条件引用不存在的发言')
  .refine(value => new Set(value.speech.map(item => item.channel)).size < 2 || value.conditions.participants.every(item => item.speechHearing?.length === value.speech.length), '混合发言渠道须逐条指定听闻条件')
export type SceneInteractionEvent = z.infer<typeof sceneInteractionEventSchema>

export function sceneInteractionDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function visibleCharacterResponse(response: CharacterResponse) {
  const value = characterResponseSchema.parse(response)
  return { responseKind: value.kind, speech: value.kind === 'respond' ? value.speech : [], actions: value.kind === 'respond' ? value.actions : [] }
}

const index = z.number().int().nonnegative()
const observationReference = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('speech'), index, range: z.tuple([index, z.number().int().positive()]).optional() }).strict(),
  z.object({ kind: z.literal('effect'), index }).strict(),
])
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
  actionDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict()
export type SceneInteractionDecision = z.infer<typeof sceneInteractionDecisionSchema>

export const sceneActionAnswerSchema = z.array(z.discriminatedUnion('status', [
  z.object({ index, status: z.enum(['succeeded', 'blocked']), reason: text, observable: text.optional() }).strict(),
  z.object({ index, status: z.literal('unresolved'), reason: text }).strict(),
])).min(1).max(8)
export const sceneActionRuleSchema = z.object({ index, allowed: z.boolean(), basis: text }).strict()
export const sceneActionRecordSchema = z.object({ formatVersion: z.literal(1), sequence: z.number().int().positive(),
  eventDigest: z.string().regex(/^[a-f0-9]{64}$/), rules: z.array(sceneActionRuleSchema).min(1).max(8), outcomes: sceneActionAnswerSchema,
}).strict()
export type SceneActionRecord = z.infer<typeof sceneActionRecordSchema>

export function verifySceneActions(event: SceneInteractionEvent, record: SceneActionRecord): void {
  if (record.sequence !== event.sequence || record.eventDigest !== sceneInteractionDigest(event) || record.rules.length !== event.actions.length || record.outcomes.length !== event.actions.length ||
    record.rules.some((rule, index) => rule.index !== index) || record.outcomes.some((outcome, index) => outcome.index !== index || (outcome.status === 'succeeded' && !record.rules[index]!.allowed))) {
    throw new Error('互动行动结果与尝试或规则判断不匹配')
  }
}

export function sceneActionEffects(record?: SceneActionRecord) {
  return record?.outcomes.flatMap(item => 'observable' in item && item.observable ? [{ index: item.index, content: item.observable }] : []) ?? []
}

export const interactionObservationIdSchema = z.object({ sequence: z.number().int().positive(), index: z.number().int().nonnegative() }).strict()
export type InteractionObservationId = z.infer<typeof interactionObservationIdSchema>
export function interactionObservationSource(sceneId: string, reference: InteractionObservationId): string {
  return `${sceneId}:interaction:${reference.sequence}:${reference.index}`
}
export function interactionObservationContent(observation: { kind: 'speech' | 'effect'; content: string }): string {
  return `${observation.kind === 'speech' ? '听见发言' : '看见结果'}：${observation.content}`
}
export const sceneInteractionDispatchSchema = z.object({ formatVersion: z.literal(1), sequence: z.number().int().positive(),
  characterId: id, participationId: id, decisionDigest: z.string().regex(/^[a-f0-9]{64}$/),
  observations: z.array(interactionObservationIdSchema).max(32),
}).strict().refine(value => new Set(value.observations.map(item => `${item.sequence}:${item.index}`)).size === value.observations.length, '投递观察引用重复')
export type SceneInteractionDispatch = z.infer<typeof sceneInteractionDispatchSchema>

/** 核对所有投递引用与调度依据，并从原发言截取实际文本。 */
export function resolveInteractionPerceptions(event: SceneInteractionEvent, input: z.infer<typeof sceneInteractionDecisionInputSchema>, actions?: SceneActionRecord) {
  const effects = sceneActionEffects(actions)
  const actors = new Map(event.conditions.participants.map(item => [item.characterId, item]))
  const perceptions = new Map(input.perceptions.map(item => [item.characterId, item]))
  if (perceptions.size !== actors.size || perceptions.size !== input.perceptions.length || [...actors.keys()].some(id => !perceptions.has(id))) {
    throw new Error('感知判定未逐一覆盖场景参与者')
  }
  const resolved = input.perceptions.map(({ characterId, status, observations, reason }) => {
    const actor = actors.get(characterId)!
    if (['not-received', 'uncertain'].includes(status) ? observations.length !== 0 : observations.length === 0) throw new Error('感知状态与投递内容不匹配')
    const hearing = (index: number) => actor.speechHearing?.find(item => item.index === index)
    if (status === 'not-received' && (event.speech.some((_, index) => (hearing(index)?.access ?? actor.hearing) === 'unknown') || (actor.sight === 'unknown' && effects.length))) throw new Error('感知条件待确认')
    const seen = new Set<string>()
    const content = observations.map(reference => {
      const key = `${reference.kind}:${reference.index}`
      if (seen.has(key)) throw new Error('感知引用缺失或重复')
      seen.add(key)
      if (reference.kind === 'effect') {
        const effect = effects.find(item => item.index === reference.index)
        if (!effect || actor.sight !== 'clear') throw new Error('角色无法核实所选行动结果')
        return { ...reference, content: effect.content, basis: actor.basis }
      }
      const original = event.speech[reference.index]
      if (!original) throw new Error('感知引用缺失或重复')
      const condition = hearing(reference.index)
      const access = condition?.access ?? actor.hearing
      if (access === 'blocked' || access === 'unknown') throw new Error('角色听不到所选发言')
      const range = reference.range ?? [0, original.text.length]
      const [start, end] = range
      if (start >= end || end > original.text.length) throw new Error('原话片段越界')
      const partial = end - start < original.text.length
      if (access === 'partial' && !partial) throw new Error('部分听见须使用原话片段')
      if (status === 'received' && partial) throw new Error('完整收到的发言不能截断')
      return { ...reference, content: original.text.slice(start, end), basis: condition?.basis ?? actor.basis }
    })
    return { characterId, status, reason, basis: actor.basis, observations: content }
  })
  if (input.next.kind === 'respond') {
    const { characterId, trigger } = input.next
    if (!actors.has(characterId) || (trigger.kind === 'observation'
      ? characterId === event.characterId || !resolved.find(item => item.characterId === characterId)?.observations[trigger.index]
      : actors.get(characterId)?.initiative?.id !== trigger.id)) throw new Error('下一位回应者缺少可用触发依据')
  }
  return resolved
}
