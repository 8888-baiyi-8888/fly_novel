import { parseDocument } from 'yaml'
import { z } from 'zod'

const id = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
const text = z.string().trim().min(1)
const participant = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('linked'), id, previousClue: z.object({ clueId: id, description: text }).strict().optional() }).strict(),
  z.object({ kind: z.literal('unresolved'), clueId: id, description: text }).strict(),
])
const entry = z.object({ id, name: text, direction: z.enum(['a-to-b', 'b-to-a', 'two-way']), description: z.string() }).strict()

/** 初始化人物关系文档；端点顺序决定条目方向，不承载角色姓名副本。 */
export const characterRelationshipSchema = z.object({
  formatVersion: z.literal(1), worldId: text, id,
  participants: z.tuple([participant, participant]),
  relations: z.array(entry), contentStatus: z.enum(['suggested', 'confirmed']),
}).strict().superRefine((value, context) => {
  const [a, b] = value.participants
  if (a.kind === 'unresolved' && b.kind === 'unresolved') context.addIssue({ code: 'custom', message: '至少一端必须为已关联角色' })
  if (a.kind === 'linked' && b.kind === 'linked' && a.id === b.id) context.addIssue({ code: 'custom', message: '关系两端不能为同一角色' })
  if (new Set(value.relations.map(item => item.id)).size !== value.relations.length) context.addIssue({ code: 'custom', message: '关系条目 ID 重复' })
})
export type CharacterRelationship = z.infer<typeof characterRelationshipSchema>

/** 解析关系 JSON；拒绝重复键、未知版本和无效结构。 */
export function parseCharacterRelationship(value: string): CharacterRelationship {
  const json: unknown = JSON.parse(value)
  if (parseDocument(value, { uniqueKeys: true }).errors.length) throw new Error('关系 JSON 含重复键或无效结构')
  return characterRelationshipSchema.parse(json)
}

/** 校验并格式化关系文档。 */
export function formatCharacterRelationship(value: CharacterRelationship): string {
  return `${JSON.stringify(characterRelationshipSchema.parse(value), null, 2)}\n`
}
