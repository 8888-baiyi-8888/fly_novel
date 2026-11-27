import { z } from 'zod'

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
