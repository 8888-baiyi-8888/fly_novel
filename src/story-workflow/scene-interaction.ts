import { createHash } from 'node:crypto'
import { z } from 'zod'
import { characterResponseSchema, type CharacterResponse } from './character-participation.js'

const id = z.string().uuid()
const text = z.string().trim().min(1).max(4000)
const channelAccess = z.enum(['clear', 'partial', 'blocked', 'unknown'])
export const sceneInteractionConditionsSchema = z.object({ version: text, participants: z.array(z.object({
  characterId: id, position: text, hearing: channelAccess, sight: channelAccess, basis: text,
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
