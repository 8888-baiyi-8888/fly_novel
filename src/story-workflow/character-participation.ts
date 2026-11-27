import { z } from 'zod'
import { createHash } from 'node:crypto'

const characterId = z.string().uuid()
export const characterInvitationSchema = z.object({ characterId, invitation: z.string().trim().min(1).max(1500) }).strict()
export const characterSelectionSchema = z.object({ participants: z.array(characterInvitationSchema) }).strict().refine(
  ({ participants }) => new Set(participants.map(item => item.characterId)).size === participants.length, '同一请求不能重复邀请同一角色',
)
export type CharacterInvitation = z.infer<typeof characterInvitationSchema>

const description = z.string().trim().min(1).max(4000)
export const characterKnowledgeGrantSchema = z.object({
  characterId, sceneId: description, category: z.enum(['profile', 'goal', 'observation', 'known', 'rumor', 'unknown']),
  content: description, basis: description,
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('profile') }).strict(),
    z.object({ kind: z.literal('scene'), field: z.enum(['situation', 'preparation']) }).strict(),
    z.object({ kind: z.literal('world'), index: z.number().int().nonnegative(), version: description }).strict(),
    z.object({ kind: z.literal('fixed'), id: description, version: description }).strict(),
  ]),
}).strict()
export type CharacterKnowledgeGrant = z.infer<typeof characterKnowledgeGrantSchema>
export const characterKnowledgeEntrySchema = characterKnowledgeGrantSchema.omit({ source: true }).extend({
  source: z.object({ kind: z.enum(['profile', 'scene', 'world', 'fixed']), id: description, version: description }).strict(),
})
export type CharacterKnowledgeEntry = z.infer<typeof characterKnowledgeEntrySchema>

const privateThought = { privateThought: description.optional() }
export const characterResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('respond'), speech: z.array(z.object({ text: description, channel: z.enum(['normal', 'whisper']),
    intendedCharacterIds: z.array(characterId).max(16) }).strict()).max(8), actions: z.array(description).max(8), ...privateThought }).strict(),
  z.object({ kind: z.literal('wait'), ...privateThought }).strict(),
  z.object({ kind: z.literal('decline'), ...privateThought }).strict(),
]).refine(value => value.kind !== 'respond' || value.speech.length + value.actions.length > 0, '角色回应缺少发言或行动尝试')
export type CharacterResponse = z.infer<typeof characterResponseSchema>
export const characterOutcomeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('responded'), response: characterResponseSchema }).strict(),
  z.object({ status: z.enum(['invalid', 'failed', 'cancelled', 'timeout']) }).strict(),
])
export type CharacterOutcome = z.infer<typeof characterOutcomeSchema>

export const characterParticipationRequestSchema = characterInvitationSchema.extend({
  participationId: characterId, worldId: description, runId: characterId, storyId: characterId, sceneId: description, profileVersion: description,
})
export type CharacterParticipationRequest = z.infer<typeof characterParticipationRequestSchema>
export const characterParticipationClaimSchema = z.object({
  formatVersion: z.literal(1), request: characterParticipationRequestSchema, configVersion: description,
  entries: z.array(characterKnowledgeEntrySchema).min(1).max(32),
}).strict().refine(({ request, entries }) => entries.every(item => item.sceneId === request.sceneId && item.characterId === request.characterId), '参与记录中的认知身份不匹配')
export type CharacterParticipationClaim = z.infer<typeof characterParticipationClaimSchema>
export const characterParticipationResultSchema = z.object({
  formatVersion: z.literal(1), participationId: characterId, claimDigest: z.string().regex(/^[0-9a-f]{64}$/),
  history: z.array(z.object({ participationId: characterId, sceneId: description }).strict()), outcome: characterOutcomeSchema,
}).strict().refine(data => new Set(data.history.map(item => item.participationId)).size === data.history.length && !data.history.some(item => item.participationId === data.participationId), '角色历史引用重复')
export type CharacterParticipationResult = z.infer<typeof characterParticipationResultSchema>
export function characterClaimDigest(value: CharacterParticipationClaim): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function projectCharacterParticipation(claim: CharacterParticipationClaim, result?: CharacterParticipationResult) {
  const { participationId, characterId, worldId, runId, storyId, sceneId } = claim.request
  const identity = { participationId, characterId, worldId, runId, storyId, sceneId }
  if (!result) return { ...identity, outcome: { status: 'pending' as const } }
  if (result.outcome.status !== 'responded') return { ...identity, outcome: result.outcome }
  const { privateThought: _privateThought, ...response } = result.outcome.response
  return { ...identity, outcome: { status: 'responded' as const, response } }
}
