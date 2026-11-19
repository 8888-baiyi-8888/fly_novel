import { parseDocument } from 'yaml'
import { z } from 'zod'

const text = z.string().trim().min(1)
export const situationIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
const identity = { formatVersion: z.literal(1), worldId: text }
const entity = { ...identity, id: situationIdSchema, name: text, contentStatus: z.enum(['suggested', 'confirmed']) }
export const startSchema = z.object({ ...identity, description: text }).strict()
export const overviewSchema = z.object({ ...entity, summary: z.string(), coverage: z.string(), reserved: z.array(text) }).strict()
export const referenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('linked'), type: z.enum(['history', 'place', 'organization', 'organization-relation', 'person', 'person-relation']), id: situationIdSchema, description: z.string(), observedVersion: z.string().min(1).nullable() }).strict(),
  z.object({ kind: z.literal('unresolved'), type: z.enum(['history', 'place', 'organization', 'organization-relation', 'person', 'person-relation', 'world-basics']), description: text }).strict(),
])
export const situationSchema = z.object({ ...entity, overviewId: situationIdSchema, aliases: z.array(text), detailLevel: z.enum(['unexpanded', 'overview', 'detailed']), summary: z.string(), body: z.string(), references: z.array(referenceSchema), relations: z.array(z.object({ targetId: situationIdSchema, description: text }).strict()), reserved: z.array(text) }).strict().superRefine((value, ctx) => {
  const ids = value.relations.map(item => item.targetId)
  if (ids.includes(value.id) || new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: '局势关联不能指向自身或重复' })
})
export type Start = z.infer<typeof startSchema>
export type Overview = z.infer<typeof overviewSchema>
export type Situation = z.infer<typeof situationSchema>
export function parseJson<T>(source: string, schema: z.ZodType<T>): T {
  const value: unknown = JSON.parse(source)
  if (parseDocument(source, { uniqueKeys: true }).errors.length) throw new Error('JSON 含重复键或无效结构')
  return schema.parse(value)
}
