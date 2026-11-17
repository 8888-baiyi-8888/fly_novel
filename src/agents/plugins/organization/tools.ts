import { defineTool, type ParameterSchemaSpec, type ToolAgentIdentity, type ToolDefinition, type ToolRunContext } from '@fly-novel/tools'
import { z } from 'zod'
import { organizationIdSchema, organizationMembershipSchema, organizationRelationSchema, organizationSchema } from './format.js'
import { OrganizationStore, OrganizationStoreError } from './store.js'
import { OrganizationQueries, organizationMembershipSearchSchema, organizationRelationSearchSchema, organizationSearchSchema, organizationTreeSchema, type OrganizationQueryBinding } from './query.js'

const organizationInput = z.object({ name: organizationSchema.shape.name, aliases: organizationSchema.shape.aliases, organizationType: organizationSchema.shape.organizationType,
  detailLevel: organizationSchema.shape.detailLevel, minLevel: organizationSchema.shape.minLevel, sections: organizationSchema.shape.sections,
  locations: organizationSchema.shape.locations, reserved: organizationSchema.shape.reserved }).strict()
const relationInput = z.object({ fromId: organizationRelationSchema.shape.fromId, toId: organizationRelationSchema.shape.toId, kind: organizationRelationSchema.shape.kind,
  label: organizationRelationSchema.shape.label, direction: organizationRelationSchema.shape.direction, fromMinLevel: organizationRelationSchema.shape.fromMinLevel,
  toMinLevel: organizationRelationSchema.shape.toMinLevel, description: organizationRelationSchema.shape.description }).strict()
const membershipInput = z.object({ organizationId: organizationMembershipSchema.shape.organizationId, person: organizationMembershipSchema.shape.person,
  roles: organizationMembershipSchema.shape.roles, period: organizationMembershipSchema.shape.period, description: organizationMembershipSchema.shape.description,
  minLevel: organizationMembershipSchema.shape.minLevel }).strict()
const read = z.object({ id: organizationIdSchema }).strict()
const create = <T extends z.ZodType>(schema: T) => z.object({ content: schema }).strict()
const update = <T extends z.ZodType>(schema: T) => z.object({ id: organizationIdSchema, version: z.string().min(1), content: schema }).strict()
const reference = z.object({ kind: z.enum(['person', 'place']), id: organizationIdSchema }).strict()
const output = { schema: { type: 'json' as const }, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] }
const str = { type: 'string' } as const
const id = { type: 'string', required: true } as const
const paging = { offset: { type: 'integer' }, limit: { type: 'integer' }, version: str } as const
const orgContent = { type: 'json', required: true, description: '组织对象：name 字符串、aliases 字符串数组、organizationType 字符串或 null、detailLevel 为 unexpanded/overview/detailed、minLevel 为 0–4；sections 数组项为 {title,content,minLevel}，locations 数组项为 {place,purpose,minLevel}，reserved 数组项为 {description,minLevel}。place 为 {kind:"linked",id:地点UUID} 或 {kind:"unresolved",description:线索}；内容等级不得低于组织等级，数组可为空。' } as const
const relationContent = { type: 'json', required: true, description: '关系对象：fromId、toId 为不同组织 UUID，kind 为 subordination 或 general，label 字符串，direction 为 one-way 或 two-way，fromMinLevel、toMinLevel 为 0–4，description 字符串；统属从下级指向上级且必须为 one-way。' } as const
const membershipContent = { type: 'json', required: true, description: '成员对象：organizationId 为组织 UUID，person 为 {kind:"linked",id:角色UUID} 或 {kind:"unresolved",description:线索}，roles 为字符串数组，period 为字符串或 null，description 为字符串，minLevel 为 0–4。' } as const

/** 创建身份绑定的组织工具；角色绑定只提供过滤后的读取，不提供写入。 */
export function createOrganizationTools(store: OrganizationStore, identity: ToolAgentIdentity, binding: OrganizationQueryBinding, access: 'read-only' | 'read-write'): ToolDefinition[] {
  if (!identity || !binding || (access !== 'read-only' && access !== 'read-write')) throw new OrganizationStoreError('组织工具身份或权限无效', 'ORG_INVALID_CONFIG')
  if (binding.kind === 'character' && access !== 'read-only') throw new OrganizationStoreError('角色视图不能装配组织写工具', 'ORG_FORBIDDEN')
  if (access === 'read-write' && !store.writable) throw new OrganizationStoreError('只读存储不能装配组织写工具', 'ORG_FORBIDDEN')
  const query = new OrganizationQueries(store, binding)
  const tool = (name: string, description: string, parameters: ParameterSchemaSpec, run: (args: unknown, exec: ToolRunContext) => Promise<unknown>, mutation = false) =>
    defineTool({ name, description, parameters, output, ...(mutation ? { reportOnAbort: true } : {}), async execute(args, exec) {
      if (exec.agent !== identity) throw new OrganizationStoreError('组织工具身份不匹配', 'ORG_FORBIDDEN')
      try { return z.json().parse(await run(args, exec)) }
      catch (error) {
        if (error instanceof OrganizationStoreError && error.code === 'ORG_COMMIT_UNKNOWN' && error.path) return { status: 'unknown', path: error.path }
        throw error
      }
    } })
  const tools = [
    tool('organization_search', '在绑定身份可见范围按名称、别名、类型及展开等级搜索组织；翻页须携带版本。', { keyword: str, organizationType: str, detailLevel: str, ...paging }, (args, exec) => query.search(organizationSearchSchema.parse(args), exec.signal)),
    tool('organization_read', '按 ID 读取身份可见的组织资料；角色只能看到其权限允许的内容。', { id }, (args, exec) => query.readOrganization(read.parse(args).id, exec.signal)),
    tool('organization_relation_read', '按 ID 读取身份可见的组织间关系。', { id }, (args, exec) => query.readRelation(read.parse(args).id, exec.signal)),
    tool('organization_relations_read', '按组织、方向及关系种类查询可见的组织间关系，不推断反向态度。', { organizationId: str, direction: str, kind: str, ...paging }, (args, exec) => query.relations(organizationRelationSearchSchema.parse(args), exec.signal)),
    tool('organization_membership_read', '按 ID 读取身份可见的成员关系。', { id }, (args, exec) => query.readMembership(read.parse(args).id, exec.signal)),
    tool('organization_memberships_read', '按组织 ID 或人物 ID 查询可见的成员关系；未关联人物只作为线索。', { organizationId: str, personId: str, ...paging }, (args, exec) => query.memberships(organizationMembershipSearchSchema.parse(args), exec.signal)),
    tool('organization_ancestors', '沿已记录的统属关系查询可见祖先与路径。', { id, depth: { type: 'integer' }, ...paging }, (args, exec) => query.tree('ancestors', organizationTreeSchema.parse(args), exec.signal)),
    tool('organization_children', '沿已记录的统属关系查询可见后代、命中路径和其他可见上级。', { id, depth: { type: 'integer' }, ...paging }, (args, exec) => query.tree('children', organizationTreeSchema.parse(args), exec.signal)),
  ]
  if (binding.kind === 'planner') tools.push(tool('organization_reference_check', '使用可信解析器重新核验人物或地点 ID；不能选择世界。', { kind: { type: 'string', enum: ['person', 'place'], required: true }, id }, (args, exec) => { const q = reference.parse(args); return store.checkReference(q.kind, q.id, exec.signal) }))
  if (access === 'read-write') tools.push(
    tool('organization_create', '创建组织建议，组织 ID 和世界由应用确定。', { content: orgContent }, (args, exec) => store.createOrganization(create(organizationInput).parse(args).content, exec.signal), true),
    tool('organization_update', '初始化期间按读取版本以完整内容覆盖组织资料。', { id, version: { type: 'string', required: true }, content: orgContent }, (args, exec) => { const q = update(organizationInput).parse(args); return store.updateOrganization(q.id, q.version, q.content, exec.signal) }, true),
    tool('organization_relation_create', '创建一条组织间关系。', { content: relationContent }, (args, exec) => store.createRelation(create(relationInput).parse(args).content, exec.signal), true),
    tool('organization_relation_update', '初始化期间按读取版本覆盖组织间关系。', { id, version: { type: 'string', required: true }, content: relationContent }, (args, exec) => { const q = update(relationInput).parse(args); return store.updateRelation(q.id, q.version, q.content, exec.signal) }, true),
    tool('organization_membership_create', '创建成员关系或未关联的人物线索。', { content: membershipContent }, (args, exec) => store.createMembership(create(membershipInput).parse(args).content, exec.signal), true),
    tool('organization_membership_update', '初始化期间按读取版本覆盖成员关系。', { id, version: { type: 'string', required: true }, content: membershipContent }, (args, exec) => { const q = update(membershipInput).parse(args); return store.updateMembership(q.id, q.version, q.content, exec.signal) }, true),
  )
  return tools
}
