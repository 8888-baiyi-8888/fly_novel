import { z } from 'zod'

const characterId = z.string().uuid()
export const characterInvitationSchema = z.object({ characterId, invitation: z.string().trim().min(1).max(1500) }).strict()
export const characterSelectionSchema = z.object({ participants: z.array(characterInvitationSchema) }).strict().refine(
  ({ participants }) => new Set(participants.map(item => item.characterId)).size === participants.length, '同一请求不能重复邀请同一角色',
)
export type CharacterInvitation = z.infer<typeof characterInvitationSchema>
