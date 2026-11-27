import { z } from 'zod'
import { sceneInteractionDigest } from './scene-interaction.js'

const uuid = z.string().uuid()
const text = z.string().min(1)
export const sceneEventDigestSchema = z.string().regex(/^[a-f0-9]{64}$/)
export const sceneEventSchema = z.object({
  formatVersion: z.literal(1), eventId: sceneEventDigestSchema, worldId: text, runId: uuid, storyId: uuid, sceneId: text,
  resultDigest: sceneEventDigestSchema, interactionDigest: sceneEventDigestSchema,
  status: z.enum(['completed', 'terminated']),
  sequence: z.array(z.object({
    order: z.number().int().positive(), participationId: uuid, characterId: uuid,
    sourceDigest: sceneEventDigestSchema,
    speech: z.array(z.object({ text, channel: z.enum(['normal', 'whisper']), intendedCharacterIds: z.array(uuid) }).strict()),
    actions: z.array(z.object({ index: z.number().int().nonnegative(), attempt: text, status: z.enum(['succeeded', 'blocked', 'unresolved']),
      reason: text, observable: text.optional(), ruleAllowed: z.boolean(), ruleBasis: text }).strict()),
  }).strict()).min(1),
}).strict()
export type SceneEvent = z.infer<typeof sceneEventSchema>

export function sceneEventIdentity(worldId: string, sceneId: string, interactionDigest: string): string {
  return sceneInteractionDigest([worldId, sceneId, interactionDigest])
}
