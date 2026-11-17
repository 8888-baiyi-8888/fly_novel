import { parseDocument } from 'yaml'
import { z } from 'zod'

const text = z.string().trim().min(1)
export const organizationIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
export const clearanceSchema = z.number().int().min(0).max(4)
const reference = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('linked'), id: organizationIdSchema }).strict(),
  z.object({ kind: z.literal('unresolved'), description: text }).strict(),
])
const section = z.object({ title: text, content: z.string(), minLevel: clearanceSchema }).strict()
const location = z.object({ place: reference, purpose: text, minLevel: clearanceSchema }).strict()
const reserved = z.object({ description: text, minLevel: clearanceSchema }).strict()

/** 组织名称、别名和基本元数据受 minLevel 保护；正文、地点和留白分别标记等级。 */
export const organizationSchema = z.object({
  formatVersion: z.literal(1), worldId: text, id: organizationIdSchema, name: text, aliases: z.array(text), organizationType: text.nullable(),
  detailLevel: z.enum(['unexpanded', 'overview', 'detailed']), reviewStatus: z.literal('suggested'),
  minLevel: clearanceSchema, sections: z.array(section), locations: z.array(location), reserved: z.array(reserved),
}).strict().superRefine((value, context) => {
  for (const item of [...value.sections, ...value.locations, ...value.reserved]) {
    if (item.minLevel < value.minLevel) context.addIssue({ code: 'custom', message: '内容等级不能低于组织基本资料等级' })
  }
})

/** 统属从 child 指向 parent；其他关系独立标记方向，不从自然语言推断。 */
export const organizationRelationSchema = z.object({
  formatVersion: z.literal(1), worldId: text, id: organizationIdSchema,
  fromId: organizationIdSchema, toId: organizationIdSchema,
  kind: z.enum(['subordination', 'general']), label: text, direction: z.enum(['one-way', 'two-way']),
  fromMinLevel: clearanceSchema, toMinLevel: clearanceSchema, description: z.string(),
}).strict().superRefine((value, context) => {
  if (value.fromId === value.toId) context.addIssue({ code: 'custom', message: '组织关系两端不能相同' })
  if (value.kind === 'subordination' && value.direction !== 'one-way') context.addIssue({ code: 'custom', message: '统属必须为子到父的单向关系' })
})

/** 成员关系的角色可为已核验引用或未建档线索；任期 null 表示未知。 */
export const organizationMembershipSchema = z.object({
  formatVersion: z.literal(1), worldId: text, id: organizationIdSchema, organizationId: organizationIdSchema,
  person: reference, roles: z.array(text), period: z.string().nullable(), description: z.string(), minLevel: clearanceSchema,
}).strict()

export type Organization = z.infer<typeof organizationSchema>
export type OrganizationRelation = z.infer<typeof organizationRelationSchema>
export type OrganizationMembership = z.infer<typeof organizationMembershipSchema>
export type OrganizationDocument = Organization | OrganizationRelation | OrganizationMembership

function strictJson(value: string): unknown {
  const json: unknown = JSON.parse(value)
  const parsed = parseDocument(value, { uniqueKeys: true })
  if (parsed.errors.length) throw new Error('JSON 包含重复键或无效结构', { cause: parsed.errors[0] })
  return json
}

/** 解析组织文档，拒绝无效结构和不支持的版本。 */
export function parseOrganization(value: string): Organization { return organizationSchema.parse(strictJson(value)) }
/** 解析组织间关系文档，拒绝无效结构和不支持的版本。 */
export function parseOrganizationRelation(value: string): OrganizationRelation { return organizationRelationSchema.parse(strictJson(value)) }
/** 解析成员关系文档，拒绝无效结构和不支持的版本。 */
export function parseOrganizationMembership(value: string): OrganizationMembership { return organizationMembershipSchema.parse(strictJson(value)) }

/** 校验并格式化已识别的组织文档。 */
export function formatOrganizationDocument(value: OrganizationDocument): string {
  const schema = 'person' in value ? organizationMembershipSchema : 'fromId' in value ? organizationRelationSchema : organizationSchema
  return `${JSON.stringify(schema.parse(value), null, 2)}\n`
}
