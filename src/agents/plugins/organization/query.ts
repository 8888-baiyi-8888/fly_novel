import { createHash } from 'node:crypto'
import { z } from 'zod'
import { clearanceSchema, organizationIdSchema, type Organization, type OrganizationMembership, type OrganizationRelation } from './format.js'
import { OrganizationStore, OrganizationStoreError } from './store.js'

const paging = { offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(20), version: z.string().min(1).optional() }
export const organizationSearchSchema = z.object({ keyword: z.string().min(1).optional(), organizationType: z.string().min(1).optional(), detailLevel: z.enum(['unexpanded', 'overview', 'detailed']).optional(), ...paging }).strict()
export const organizationRelationSearchSchema = z.object({ organizationId: organizationIdSchema.optional(), direction: z.enum(['in', 'out', 'any']).default('any'), kind: z.enum(['subordination', 'general']).optional(), ...paging }).strict()
export const organizationMembershipSearchSchema = z.object({ organizationId: organizationIdSchema.optional(), personId: organizationIdSchema.optional(), ...paging }).strict()
export const organizationTreeSchema = z.object({ id: organizationIdSchema, depth: z.number().int().min(1).max(32).default(1), ...paging }).strict()

const grantsSchema = z.object({ worldId: z.string().min(1), characterId: organizationIdSchema, revision: z.string().min(1),
  grants: z.array(z.object({ organizationId: organizationIdSchema, level: clearanceSchema }).strict()) }).strict().superRefine((value, ctx) => {
  if (new Set(value.grants.map(item => item.organizationId)).size !== value.grants.length) ctx.addIssue({ code: 'custom', message: '组织授权重复' })
})
/** 必须由可信应用绑定角色、世界和仅针对该角色的授权版本；不得由模型指定。 */
export type OrganizationQueryBinding = { kind: 'planner'; worldId: string } | {
  kind: 'character'; worldId: string; characterId: string
  readGrants: (signal?: AbortSignal) => Promise<z.input<typeof grantsSchema>>
}
type Projection<T> = { document: T; version: string; path?: string }
type Visible = { organizations: Projection<Organization>[]; relations: Projection<OrganizationRelation>[]; memberships: Projection<OrganizationMembership>[]; authorization: string; scope: 'world' | 'character' }
type PageInput = { offset: number; limit: number; version?: string }

function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
function notFound(): never { throw new OrganizationStoreError('在当前可见范围内未找到组织资料', 'ORG_NOT_FOUND') }
function page<T>(view: Visible, tag: string, filters: object, input: PageInput, items: T[]) {
  const version = digest([tag, filters, view.authorization, view.organizations, view.relations, view.memberships])
  if (input.offset > 0 && !input.version) throw new OrganizationStoreError('后续页需要查询版本', 'ORG_CONFLICT')
  if (input.version && input.version !== version) throw new OrganizationStoreError('可见资料或授权已变化，请重新查询', 'ORG_CONFLICT')
  const next = input.offset + input.limit
  return { items: items.slice(input.offset, next), nextOffset: next < items.length ? next : null, version, scope: view.scope }
}

/** 按可信绑定创建查询；角色视图从不暴露原始路径、文件版本或未授权内容。 */
export class OrganizationQueries {
  private readonly binding: OrganizationQueryBinding
  constructor(private readonly store: OrganizationStore, binding: OrganizationQueryBinding) {
    if (!binding || binding.worldId !== store.worldId || (binding.kind !== 'planner' && binding.kind !== 'character')) throw new OrganizationStoreError('组织查询世界或身份无效', 'ORG_INVALID_CONFIG')
    if (binding.kind === 'character') {
      organizationIdSchema.parse(binding.characterId)
      if (typeof binding.readGrants !== 'function') throw new OrganizationStoreError('角色授权来源不可用', 'ORG_INVALID_CONFIG')
    }
    this.binding = { ...binding }
  }
  private async grants(signal?: AbortSignal) {
    if (this.binding.kind !== 'character') throw new OrganizationStoreError('非角色视图不能读取角色授权', 'ORG_FORBIDDEN')
    signal?.throwIfAborted()
    let parsed: z.output<typeof grantsSchema>
    try { parsed = grantsSchema.parse(await this.binding.readGrants(signal)) } catch (error) {
      if (signal?.aborted) throw error
      throw new OrganizationStoreError('组织查询暂不可用', 'ORG_QUERY_UNAVAILABLE')
    }
    signal?.throwIfAborted()
    if (parsed.worldId !== this.store.worldId || parsed.characterId !== this.binding.characterId) throw new OrganizationStoreError('角色授权身份不匹配', 'ORG_FORBIDDEN')
    return { ...parsed, grants: [...parsed.grants].sort((a, b) => a.organizationId.localeCompare(b.organizationId)) }
  }
  private async view(signal?: AbortSignal): Promise<Visible> {
    const before = this.binding.kind === 'character' ? await this.grants(signal) : undefined
    let snapshot
    try { snapshot = await this.store.snapshot(signal) } catch (error) {
      if (this.binding.kind === 'character' && !signal?.aborted) throw new OrganizationStoreError('组织查询暂不可用', 'ORG_QUERY_UNAVAILABLE')
      throw error
    }
    if (!before) return { organizations: snapshot.organizations, relations: snapshot.relations, memberships: snapshot.memberships, authorization: 'planner', scope: 'world' }
    const after = await this.grants(signal)
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new OrganizationStoreError('角色授权已变化，请重新查询', 'ORG_CONFLICT')
    const levels = new Map(before.grants.map(grant => [grant.organizationId, grant.level]))
    const level = (id: string) => levels.get(id) ?? 0
    const project = <T>(document: T): Projection<T> => ({ document, version: digest(document) })
    const organizations = snapshot.organizations.filter(({ document }) => level(document.id) >= document.minLevel).map(({ document }) => project({
      ...document, sections: document.sections.filter(item => level(document.id) >= item.minLevel),
      locations: document.locations.filter(item => level(document.id) >= item.minLevel), reserved: document.reserved.filter(item => level(document.id) >= item.minLevel),
    }))
    const visible = new Map(organizations.map(({ document }) => [document.id, document]))
    const relations = snapshot.relations.filter(({ document }) => {
      const from = visible.get(document.fromId); const to = visible.get(document.toId)
      return !!from && !!to && level(from.id) >= Math.max(from.minLevel, document.fromMinLevel) && level(to.id) >= Math.max(to.minLevel, document.toMinLevel)
    }).map(({ document }) => project(document))
    const memberships = snapshot.memberships.filter(({ document }) => {
      const org = visible.get(document.organizationId)
      return !!org && level(org.id) >= Math.max(org.minLevel, document.minLevel)
    }).map(({ document }) => project(document))
    return { organizations, relations, memberships, authorization: digest(before), scope: 'character' }
  }
  private find<T extends { id: string }>(items: Projection<T>[], id: string): Projection<T> {
    return items.find(item => item.document.id === id) ?? notFound()
  }

  /** 按名称、别名、类型和展开程度筛选，分页只包含可见资料。 */
  async search(input: z.input<typeof organizationSearchSchema>, signal?: AbortSignal) {
    const q = organizationSearchSchema.parse(input); const view = await this.view(signal)
    const items = view.organizations.filter(({ document }) => (!q.keyword || [document.name, ...document.aliases].some(value => value.includes(q.keyword!))) &&
      (!q.organizationType || document.organizationType === q.organizationType) && (!q.detailLevel || document.detailLevel === q.detailLevel))
    return page(view, 'organization-search', { keyword: q.keyword ?? null, organizationType: q.organizationType ?? null, detailLevel: q.detailLevel ?? null }, q, items)
  }
  /** 按 ID 读取授权范围内的组织内容。 */
  async readOrganization(id: string, signal?: AbortSignal) { organizationIdSchema.parse(id); const view = await this.view(signal); return this.find(view.organizations, id) }
  /** 按 ID 读取可见关系。 */
  async readRelation(id: string, signal?: AbortSignal) { organizationIdSchema.parse(id); const view = await this.view(signal); return this.find(view.relations, id) }
  /** 按 ID 读取可见成员关系。 */
  async readMembership(id: string, signal?: AbortSignal) { organizationIdSchema.parse(id); const view = await this.view(signal); return this.find(view.memberships, id) }
  /** 按组织和方向查询组织间关系，不推断反向态度。 */
  async relations(input: z.input<typeof organizationRelationSearchSchema>, signal?: AbortSignal) {
    const q = organizationRelationSearchSchema.parse(input); const view = await this.view(signal)
    const items = view.relations.filter(({ document: r }) => (!q.kind || r.kind === q.kind) && (!q.organizationId || (q.direction === 'any' ? r.fromId === q.organizationId || r.toId === q.organizationId : q.direction === 'out' ? r.fromId === q.organizationId || (r.direction === 'two-way' && r.toId === q.organizationId) : r.toId === q.organizationId || (r.direction === 'two-way' && r.fromId === q.organizationId))))
    return page(view, 'organization-relations', { organizationId: q.organizationId ?? null, direction: q.direction, kind: q.kind ?? null }, q, items)
  }
  /** 按组织或人物筛选成员记录；未关联线索不会冒充某个人物。 */
  async memberships(input: z.input<typeof organizationMembershipSearchSchema>, signal?: AbortSignal) {
    const q = organizationMembershipSearchSchema.parse(input); const view = await this.view(signal)
    const items = view.memberships.filter(({ document }) => (!q.organizationId || document.organizationId === q.organizationId) && (!q.personId || (document.person.kind === 'linked' && document.person.id === q.personId)))
    return page(view, 'organization-memberships', { organizationId: q.organizationId ?? null, personId: q.personId ?? null }, q, items)
  }
  /** 查询可见的统属祖先或后代，返回命中路径和已授权的其他上级。 */
  async tree(mode: 'ancestors' | 'children', input: z.input<typeof organizationTreeSchema>, signal?: AbortSignal) {
    const q = organizationTreeSchema.parse(input); const view = await this.view(signal); this.find(view.organizations, q.id)
    const links = view.relations.map(item => item.document).filter(item => item.kind === 'subordination')
    const found = new Map<string, { organization: Projection<Organization>; paths: string[][] }>()
    let frontier = [{ id: q.id, path: [q.id] }]; let visited = 0
    for (let i = 0; i < q.depth && frontier.length; i++) {
      const next: typeof frontier = []
      for (const item of frontier) for (const link of links) {
        signal?.throwIfAborted()
        const id = mode === 'ancestors' ? (link.fromId === item.id ? link.toId : undefined) : (link.toId === item.id ? link.fromId : undefined)
        if (!id) continue
        if (++visited > 10000) throw new OrganizationStoreError('组织关系路径数量超过限制', 'ORG_LIMIT')
        const path = [...item.path, id]; const existing = found.get(id)
        if (existing) existing.paths.push(path); else found.set(id, { organization: this.find(view.organizations, id), paths: [path] })
        next.push({ id, path })
      }
      frontier = next
    }
    const truncated = frontier.some(item => links.some(link => mode === 'ancestors' ? link.fromId === item.id : link.toId === item.id))
    const items = [...found.values()].map(item => ({ ...item, visibleParents: links.filter(link => link.fromId === item.organization.document.id).map(link => link.toId) }))
    return { ...page(view, `organization-${mode}`, { id: q.id, depth: q.depth }, q, items), truncated }
  }
}
