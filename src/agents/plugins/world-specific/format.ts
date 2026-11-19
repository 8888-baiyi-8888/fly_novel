import { parseDocument } from 'yaml'
import { z } from 'zod'

const text = z.string().trim().min(1)
export const specificIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
export const specificKindSchema = z.enum(['topic', 'item'])
export const specificReferenceTypeSchema = z.enum(['history', 'place', 'organization', 'organization-relation', 'person', 'person-relation', 'situation-overview', 'situation', 'development-macro-blueprint', 'development-direction', 'development-proposal', 'development-storyline', 'development-growth-line', 'development-growth-blueprint', 'development-growth-item'])
export const specificReferenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('linked'), type: specificReferenceTypeSchema, id: specificIdSchema, description: z.string(), observedVersion: z.string().min(1).nullable() }).strict(),
  z.object({ kind: z.literal('unresolved'), type: z.union([specificReferenceTypeSchema, z.literal('world-basics')]), description: text }).strict(),
])
export const specificContentSchema = z.object({ name: text, aliases: z.array(text), detailLevel: z.enum(['unexpanded', 'overview', 'detailed']), summary: z.string(), body: z.string(), reserved: z.array(text), topicIds: z.array(specificIdSchema), links: z.array(z.object({ kind: specificKindSchema, id: specificIdSchema, description: text }).strict()), references: z.array(specificReferenceSchema) }).strict().superRefine((value, ctx) => {
  if (new Set(value.topicIds).size !== value.topicIds.length) ctx.addIssue({ code: 'custom', message: '主题归属重复' })
  const keys = value.links.map(item => JSON.stringify([item.kind, item.id])); if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', message: '内容关联重复' })
})
export const specificDocumentSchema = specificContentSchema.safeExtend({ formatVersion: z.literal(1), worldId: text, id: specificIdSchema, kind: specificKindSchema, contentStatus: z.enum(['suggested', 'confirmed']) }).strict().superRefine((value, ctx) => {
  if (value.kind === 'topic' && value.topicIds.length !== 0) ctx.addIssue({ code: 'custom', message: '主题不通过内容归属定义层级' })
  if (value.kind === 'item' && value.topicIds.length === 0) ctx.addIssue({ code: 'custom', message: '内容至少关联一个主题' })
  if (value.links.some(link => link.kind === value.kind && link.id === value.id)) ctx.addIssue({ code: 'custom', message: '不能关联自身' })
})
export type SpecificKind = z.infer<typeof specificKindSchema>
export type SpecificContent = z.infer<typeof specificContentSchema>
export type SpecificDocument = z.infer<typeof specificDocumentSchema>
/** 解析严格 JSON，拒绝重复键与未知格式。 */
export function parseSpecificJson<T>(source: string, schema: z.ZodType<T>): T {
  const value: unknown = JSON.parse(source)
  if (parseDocument(source, { uniqueKeys: true }).errors.length) throw new Error('JSON 含重复键或无效结构')
  return schema.parse(value)
}
