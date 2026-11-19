import { parseDocument } from 'yaml'
import { z } from 'zod'

export const idSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
const text = z.string().trim().min(1)
export const kindSchema = z.enum(['macro-blueprint', 'direction', 'proposal', 'storyline', 'growth-line', 'growth-blueprint', 'growth-item'])
export type DevelopmentKind = z.infer<typeof kindSchema>
const scope = z.object({ overviewId: idSchema, description: text, situationIds: z.array(idSchema), observedVersion: z.string().min(1).nullable().optional() }).strict().refine(value => new Set(value.situationIds).size === value.situationIds.length, '局势条目重复')
export const applicabilitySchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('unknown') }).strict(), z.object({ kind: z.literal('general'), description: text }).strict(), z.object({ kind: z.literal('scoped'), scopes: z.array(scope).min(1) }).strict().refine(value => new Set(value.scopes.map(item => item.overviewId)).size === value.scopes.length, '局势方案重复')])
export const personSchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('linked'), id: idSchema, originalClue: text.optional() }).strict(), z.object({ kind: z.literal('unresolved'), description: text }).strict()])
export const referenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('linked'), type: z.enum(['history', 'place', 'organization', 'organization-relation', 'person', 'person-relation']), id: idSchema, description: z.string(), observedVersion: z.string().min(1).nullable() }).strict(),
  z.object({ kind: z.literal('unresolved'), type: z.enum(['history', 'place', 'organization', 'organization-relation', 'person', 'person-relation', 'world-basics']), description: text }).strict(),
])
export const linkSchema = z.object({ targetKind: kindSchema, targetId: idSchema, relation: text, description: z.string() }).strict()
export const contentSchema = z.object({ name: text, summary: z.string(), body: z.string(), reserved: z.array(text), applicability: applicabilitySchema, references: z.array(referenceSchema), links: z.array(linkSchema), person: personSchema.nullable() }).strict()
export const documentSchema = contentSchema.extend({ formatVersion: z.literal(1), worldId: text, id: idSchema, kind: kindSchema, contentStatus: z.enum(['suggested', 'confirmed']) }).strict().superRefine((value, ctx) => {
  if ((value.kind === 'growth-line') !== (value.person !== null)) ctx.addIssue({ code: 'custom', message: '只有成长线必须绑定人物或未关联线索' })
  if (value.links.some(item => item.targetKind === value.kind && item.targetId === value.id)) ctx.addIssue({ code: 'custom', message: '规划不能关联自身' })
  const keys = value.links.map(item => JSON.stringify([item.targetKind, item.targetId, item.relation]))
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', message: '规划关联重复' })
})
export type DevelopmentContent = z.infer<typeof contentSchema>
export type DevelopmentDocument = z.infer<typeof documentSchema>
/** 拒绝非严格 JSON、重复键和不符合格式的文档。 */
export function parseDocumentJson<T>(source: string, schema: z.ZodType<T>): T {
  const data: unknown = JSON.parse(source)
  if (parseDocument(source, { uniqueKeys: true }).errors.length) throw new Error('JSON 含重复键或无效结构')
  return schema.parse(data)
}
