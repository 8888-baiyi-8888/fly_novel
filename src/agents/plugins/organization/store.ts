import { randomUUID } from 'node:crypto'
import { isAbsolute, join, resolve } from 'node:path'
import type { FileSystem, FsTarget, FsVersion } from '@fly-novel/fs'
import { formatOrganizationDocument, organizationIdSchema, organizationMembershipSchema, organizationRelationSchema, organizationSchema,
  parseOrganization, parseOrganizationMembership, parseOrganizationRelation,
  type Organization, type OrganizationDocument, type OrganizationMembership, type OrganizationRelation } from './format.js'

export type OrganizationStoreErrorCode = 'ORG_INVALID_CONFIG' | 'ORG_BUSY' | 'ORG_CLOSED' | 'ORG_FORBIDDEN' | 'ORG_NOT_FOUND' |
  'ORG_INVALID_DOCUMENT' | 'ORG_CONFLICT' | 'ORG_LIMIT' | 'ORG_COMMIT_UNKNOWN' | 'ORG_REFERENCE_UNAVAILABLE' | 'ORG_QUERY_UNAVAILABLE'

/** 不确定写入结果携带相对路径；调用方须先核查，不盲目重试。 */
export class OrganizationStoreError extends Error {
  constructor(message: string, readonly code: OrganizationStoreErrorCode, readonly path?: string, options?: ErrorOptions) {
    super(message, options); this.name = 'OrganizationStoreError'
  }
}

/** 由可信应用绑定到具体世界；返回实际身份，不能根据调用者输入虚构。 */
export type OrganizationReferenceResolver = (id: string, signal?: AbortSignal) => Promise<{ id: string; worldId: string } | null>
export interface OrganizationStoreConfig {
  fs: FileSystem
  root: string
  worldId: string
  /** 本存储只支持初始化；世界演化后的历史留存必须由后续入口实现。 */
  phase: 'initialization'
  access: 'read-only' | 'read-write'
  singleWriterProcess: true
  resolvePerson?: OrganizationReferenceResolver
  resolvePlace?: OrganizationReferenceResolver
  maxDocumentBytes?: number
  maxDocuments?: number
}
export interface StoredOrganizationDocument<T> { document: T; path: string; version: FsVersion }
export interface CreatedOrganizationDocument { id: string; path: string; version: FsVersion }
/** 仅供可信查询层使用的完整扫描；不能直接暴露给故事角色。 */
export interface OrganizationSnapshot {
  organizations: StoredOrganizationDocument<Organization>[]
  relations: StoredOrganizationDocument<OrganizationRelation>[]
  memberships: StoredOrganizationDocument<OrganizationMembership>[]
}
type Directory = 'organizations' | 'relations' | 'memberships'
type OrganizationInput = Omit<Organization, 'formatVersion' | 'worldId' | 'id' | 'reviewStatus'>
type RelationInput = Omit<OrganizationRelation, 'formatVersion' | 'worldId' | 'id'>
type MembershipInput = Omit<OrganizationMembership, 'formatVersion' | 'worldId' | 'id'>
const occupiedWorlds = new Set<string>(); const occupiedRoots = new Set<string>()

/** 同一实例串行处理初始化资料；持有者负责单可信写入进程及等待 close。 */
export class OrganizationStore {
  private tail: Promise<void> = Promise.resolve()
  private closed = false
  private closing?: Promise<void>
  private constructor(private readonly config: OrganizationStoreConfig, private readonly rootPath: string, private readonly root: FsTarget,
    private readonly maxDocumentBytes: number, private readonly maxDocuments: number) {}

  /** 由可信应用绑定，不由工具参数选择。 */
  get worldId(): string { return this.config.worldId }
  /** 表明该句柄允许写入；查询授权由调用方单独绑定。 */
  get writable(): boolean { return this.config.access === 'read-write' }

  /** 打开已有真实目录；不创建目录，不启动角色权限或世界演化流程。 */
  static async open(config: OrganizationStoreConfig): Promise<OrganizationStore> {
    if (!config || config.singleWriterProcess !== true || config.phase !== 'initialization' || !config.fs || typeof config.worldId !== 'string' || !config.worldId ||
      config.worldId.trim() !== config.worldId || typeof config.root !== 'string' || !isAbsolute(config.root) ||
      (config.access !== 'read-only' && config.access !== 'read-write') ||
      (config.resolvePerson !== undefined && typeof config.resolvePerson !== 'function') || (config.resolvePlace !== undefined && typeof config.resolvePlace !== 'function')) {
      throw new OrganizationStoreError('组织存储配置无效', 'ORG_INVALID_CONFIG')
    }
    const maxDocumentBytes = config.maxDocumentBytes ?? 1024 * 1024; const maxDocuments = config.maxDocuments ?? 10000
    if (![maxDocumentBytes, maxDocuments].every(value => Number.isSafeInteger(value) && value > 0)) throw new OrganizationStoreError('组织存储限制必须为正整数', 'ORG_INVALID_CONFIG')
    const path = resolve(config.root); const physical = await config.fs.resolve(path); const info = await config.fs.lstat(path)
    if (!info || info.type !== 'directory' || config.fs.processPath(physical) !== path) throw new OrganizationStoreError('组织根必须是现有真实绝对目录', 'ORG_INVALID_CONFIG')
    if (occupiedWorlds.has(config.worldId) || occupiedRoots.has(physical.targetKey)) throw new OrganizationStoreError('组织世界或目录正在使用', 'ORG_BUSY')
    occupiedWorlds.add(config.worldId); occupiedRoots.add(physical.targetKey)
    const store = new OrganizationStore({ ...config }, path, physical, maxDocumentBytes, maxDocuments)
    try { for (const name of ['organizations', 'relations', 'memberships'] as const) await store.directory(name); return store }
    catch (error) { occupiedWorlds.delete(config.worldId); occupiedRoots.delete(physical.targetKey); throw error }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new OrganizationStoreError('组织存储已关闭', 'ORG_CLOSED'))
    const result = this.tail.then(operation); this.tail = result.then(() => undefined, () => undefined); return result
  }
  private async directory(name: Directory): Promise<FsTarget> {
    const path = join(this.rootPath, name); const info = await this.config.fs.lstat(path)
    if (!info || info.type !== 'directory') throw new OrganizationStoreError('组织子目录必须为现有真实目录', 'ORG_INVALID_CONFIG', name)
    const target = await this.config.fs.resolve(path)
    if (!this.config.fs.contains(this.root, target) || this.config.fs.processPath(target) !== path) throw new OrganizationStoreError('组织子目录超出授权范围', 'ORG_FORBIDDEN', name)
    return target
  }
  private async target(name: Directory, id: string): Promise<FsTarget> {
    const fs = this.config.fs; const root = await fs.resolve(this.rootPath)
    if (root.targetKey !== this.root.targetKey || (await fs.lstat(this.rootPath))?.type !== 'directory') throw new OrganizationStoreError('组织根目录已变化', 'ORG_CONFLICT')
    await this.directory(name)
    const path = `${name}/${id}.json`; const absolute = join(this.rootPath, name, `${id}.json`); const info = await fs.lstat(absolute)
    if (info && info.type !== 'file') throw new OrganizationStoreError('组织文档必须是普通文件', 'ORG_FORBIDDEN', path)
    const target = await fs.resolve(absolute)
    if (!fs.contains(this.root, target)) throw new OrganizationStoreError('组织文档超出授权范围', 'ORG_FORBIDDEN', path)
    return target
  }
  private async read<T extends OrganizationDocument>(name: Directory, id: string, parse: (text: string) => T, signal?: AbortSignal): Promise<StoredOrganizationDocument<T>> {
    organizationIdSchema.parse(id); signal?.throwIfAborted()
    const path = `${name}/${id}.json`; const target = await this.target(name, id); const fs = this.config.fs
    const before = await fs.stat(target, signal)
    if (!before) throw new OrganizationStoreError('组织文档不存在', 'ORG_NOT_FOUND', path)
    if (before.type !== 'file') throw new OrganizationStoreError('组织文档不是普通文件', 'ORG_FORBIDDEN', path)
    const bytes = await fs.readBytes(target, signal, this.maxDocumentBytes); const after = await fs.stat(target, signal); const fresh = await this.target(name, id)
    if (!after || after.version !== before.version || fresh.targetKey !== target.targetKey) throw new OrganizationStoreError('组织文档读取期间变化', 'ORG_CONFLICT', path)
    let document: T
    try { document = parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
    catch (error) { throw new OrganizationStoreError('组织文档损坏、格式无效或版本不支持', 'ORG_INVALID_DOCUMENT', path, { cause: error }) }
    if (document.id !== id || document.worldId !== this.config.worldId) throw new OrganizationStoreError('组织文档身份不匹配', 'ORG_INVALID_DOCUMENT', path)
    return { document, path, version: after.version }
  }
  private async scan<T extends OrganizationDocument>(name: Directory, parse: (text: string) => T, signal?: AbortSignal): Promise<Map<string, StoredOrganizationDocument<T>>> {
    const entries = await this.config.fs.listDir(await this.directory(name), signal)
    if (entries.length > this.maxDocuments) throw new OrganizationStoreError('组织文档数量超过限制', 'ORG_LIMIT', name)
    const result = new Map<string, StoredOrganizationDocument<T>>()
    for (const entry of entries) {
      signal?.throwIfAborted()
      if (!entry.name.endsWith('.json')) continue
      const id = entry.name.slice(0, -5)
      if (!organizationIdSchema.safeParse(id).success || result.has(id)) throw new OrganizationStoreError('组织文档文件名无效或重复', 'ORG_INVALID_DOCUMENT', `${name}/${entry.name}`)
      result.set(id, await this.read(name, id, parse, signal))
    }
    return result
  }
  private validateRelations(organizations: Map<string, StoredOrganizationDocument<Organization>>, relations: Iterable<OrganizationRelation>): void {
    const parents = new Map<string, string[]>()
    for (const document of relations) {
      if (!organizations.has(document.fromId) || !organizations.has(document.toId)) throw new OrganizationStoreError('组织关系端点不存在', 'ORG_INVALID_DOCUMENT')
      if (document.kind === 'subordination') parents.set(document.fromId, [...(parents.get(document.fromId) ?? []), document.toId])
    }
    const done = new Set<string>(); const active = new Set<string>()
    for (const id of parents.keys()) {
      const stack: { id: string; exit: boolean }[] = [{ id, exit: false }]
      while (stack.length) {
        const item = stack.pop()!
        if (item.exit) { active.delete(item.id); done.add(item.id); continue }
        if (active.has(item.id)) throw new OrganizationStoreError('组织统属关系存在循环', 'ORG_INVALID_DOCUMENT')
        if (done.has(item.id)) continue
        active.add(item.id); stack.push({ id: item.id, exit: true })
        for (const parent of parents.get(item.id) ?? []) stack.push({ id: parent, exit: false })
      }
    }
  }
  private async verifyReference(kind: 'person' | 'place', id: string, signal?: AbortSignal): Promise<void> {
    const resolver = kind === 'person' ? this.config.resolvePerson : this.config.resolvePlace
    if (!resolver) throw new OrganizationStoreError('可信跨模块引用解析器未装配', 'ORG_REFERENCE_UNAVAILABLE')
    signal?.throwIfAborted(); const result = await resolver(id, signal); signal?.throwIfAborted()
    if (!result || result.id !== id || result.worldId !== this.config.worldId) throw new OrganizationStoreError('引用不存在或不属于当前世界', 'ORG_INVALID_DOCUMENT')
  }
  private async verifyOrganization(value: Organization, signal?: AbortSignal): Promise<void> {
    for (const item of value.locations) if (item.place.kind === 'linked') await this.verifyReference('place', item.place.id, signal)
  }
  private async verifyMembership(value: OrganizationMembership, signal?: AbortSignal): Promise<void> {
    await this.read('organizations', value.organizationId, parseOrganization, signal)
    if (value.person.kind === 'linked') await this.verifyReference('person', value.person.id, signal)
  }
  private async write(name: Directory, value: OrganizationDocument, expected: { kind: 'createIfAbsent' } | { kind: 'replaceIfVersion'; version: FsVersion }, signal?: AbortSignal): Promise<FsVersion> {
    const path = `${name}/${value.id}.json`
    if (this.config.access !== 'read-write') throw new OrganizationStoreError('当前组织存储只读', 'ORG_FORBIDDEN')
    signal?.throwIfAborted(); const content = formatOrganizationDocument(value)
    if (Buffer.byteLength(content, 'utf8') > this.maxDocumentBytes) throw new OrganizationStoreError('组织文档超过大小限制', 'ORG_LIMIT', path)
    const target = await this.target(name, value.id)
    try { return (await this.config.fs.writeText(target, content, expected, signal)).version }
    catch (error) {
      if (error instanceof Error && 'code' in error && (error.code === 'FS_STALE_VERSION' || error.code === 'FS_NOT_OBSERVED')) throw new OrganizationStoreError('组织文档已存在或版本已变化', 'ORG_CONFLICT', path, { cause: error })
      if (error instanceof Error && 'code' in error && error.code === 'FS_ABORTED') throw error
      throw new OrganizationStoreError('组织文档发布结果不确定，请核查目标', 'ORG_COMMIT_UNKNOWN', path, { cause: error })
    }
  }
  private async created<T extends OrganizationDocument>(name: Directory, document: T, signal?: AbortSignal): Promise<CreatedOrganizationDocument> {
    const version = await this.write(name, document, { kind: 'createIfAbsent' }, signal)
    return { id: document.id, path: `${name}/${document.id}.json`, version }
  }
  private async updated<T extends OrganizationDocument>(name: Directory, document: T, version: FsVersion, signal?: AbortSignal): Promise<{ path: string; version: FsVersion }> {
    return { path: `${name}/${document.id}.json`, version: await this.write(name, document, { kind: 'replaceIfVersion', version }, signal) }
  }

  /** 创建独立组织建议，地点引用由可信解析器校验。 */
  createOrganization(input: OrganizationInput, signal?: AbortSignal): Promise<CreatedOrganizationDocument> {
    return this.enqueue(async () => {
      const all = await this.scan('organizations', parseOrganization, signal)
      if (all.size >= this.maxDocuments) throw new OrganizationStoreError('组织数量超过限制', 'ORG_LIMIT')
      const value = organizationSchema.parse({ ...input, id: randomUUID(), formatVersion: 1, worldId: this.config.worldId, reviewStatus: 'suggested' })
      if (all.has(value.id)) throw new OrganizationStoreError('生成的组织身份已存在', 'ORG_CONFLICT')
      await this.verifyOrganization(value, signal); return this.created('organizations', value, signal)
    })
  }
  /** 读取组织文档；返回文件版本用于初始化期间覆盖。 */
  readOrganization(id: string, signal?: AbortSignal): Promise<StoredOrganizationDocument<Organization>> { return this.enqueue(() => this.read('organizations', id, parseOrganization, signal)) }
  /** 初始化期间按版本直接覆盖组织资料，保持组织 ID。 */
  updateOrganization(id: string, version: string, input: OrganizationInput, signal?: AbortSignal): Promise<{ path: string; version: FsVersion }> {
    return this.enqueue(async () => {
      const current = await this.read('organizations', id, parseOrganization, signal)
      if (version !== current.version) throw new OrganizationStoreError('组织文档版本已变化', 'ORG_CONFLICT', current.path)
      const value = organizationSchema.parse({ ...input, id, formatVersion: 1, worldId: this.config.worldId, reviewStatus: 'suggested' })
      await this.verifyOrganization(value, signal); return this.updated('organizations', value, current.version, signal)
    })
  }
  /** 创建组织间关系；端点必须存在，统属图不能成环。 */
  createRelation(input: RelationInput, signal?: AbortSignal): Promise<CreatedOrganizationDocument> {
    return this.enqueue(async () => {
      const orgs = await this.scan('organizations', parseOrganization, signal); const relations = await this.scan('relations', parseOrganizationRelation, signal)
      if (relations.size >= this.maxDocuments) throw new OrganizationStoreError('组织关系数量超过限制', 'ORG_LIMIT')
      const value = organizationRelationSchema.parse({ ...input, id: randomUUID(), formatVersion: 1, worldId: this.config.worldId })
      if (relations.has(value.id)) throw new OrganizationStoreError('生成的关系身份已存在', 'ORG_CONFLICT')
      this.validateRelations(orgs, [...Array.from(relations.values(), entry => entry.document), value])
      return this.created('relations', value, signal)
    })
  }
  /** 读取组织间关系；同时验证已存组织和统属图。 */
  readRelation(id: string, signal?: AbortSignal): Promise<StoredOrganizationDocument<OrganizationRelation>> {
    return this.enqueue(async () => {
      organizationIdSchema.parse(id); const orgs = await this.scan('organizations', parseOrganization, signal); const relations = await this.scan('relations', parseOrganizationRelation, signal)
      this.validateRelations(orgs, Array.from(relations.values(), entry => entry.document)); const found = relations.get(id)
      if (!found) throw new OrganizationStoreError('组织关系不存在', 'ORG_NOT_FOUND')
      return found
    })
  }
  /** 初始化期间按版本覆盖组织间关系；先校验新图。 */
  updateRelation(id: string, version: string, input: RelationInput, signal?: AbortSignal): Promise<{ path: string; version: FsVersion }> {
    return this.enqueue(async () => {
      organizationIdSchema.parse(id); const orgs = await this.scan('organizations', parseOrganization, signal); const relations = await this.scan('relations', parseOrganizationRelation, signal)
      this.validateRelations(orgs, Array.from(relations.values(), entry => entry.document)); const current = relations.get(id)
      if (!current) throw new OrganizationStoreError('组织关系不存在', 'ORG_NOT_FOUND')
      if (version !== current.version) throw new OrganizationStoreError('组织关系版本已变化', 'ORG_CONFLICT', current.path)
      const value = organizationRelationSchema.parse({ ...input, id, formatVersion: 1, worldId: this.config.worldId })
      relations.set(id, { ...current, document: value }); this.validateRelations(orgs, Array.from(relations.values(), entry => entry.document))
      return this.updated('relations', value, current.version, signal)
    })
  }
  /** 创建成员关系或未关联线索；已关联人物须由可信解析器核验。 */
  createMembership(input: MembershipInput, signal?: AbortSignal): Promise<CreatedOrganizationDocument> {
    return this.enqueue(async () => {
      const entries = await this.scan('memberships', parseOrganizationMembership, signal)
      if (entries.size >= this.maxDocuments) throw new OrganizationStoreError('成员关系数量超过限制', 'ORG_LIMIT')
      const value = organizationMembershipSchema.parse({ ...input, id: randomUUID(), formatVersion: 1, worldId: this.config.worldId })
      if (entries.has(value.id)) throw new OrganizationStoreError('生成的成员关系身份已存在', 'ORG_CONFLICT')
      await this.verifyMembership(value, signal); return this.created('memberships', value, signal)
    })
  }
  /** 读取成员关系；外部人物引用是写入时核验的记录，不代表仍可读取。 */
  readMembership(id: string, signal?: AbortSignal): Promise<StoredOrganizationDocument<OrganizationMembership>> {
    return this.enqueue(async () => {
      const value = await this.read('memberships', id, parseOrganizationMembership, signal)
      await this.read('organizations', value.document.organizationId, parseOrganization, signal); return value
    })
  }
  /** 初始化期间按版本覆盖成员关系。 */
  updateMembership(id: string, version: string, input: MembershipInput, signal?: AbortSignal): Promise<{ path: string; version: FsVersion }> {
    return this.enqueue(async () => {
      const current = await this.read('memberships', id, parseOrganizationMembership, signal)
      if (version !== current.version) throw new OrganizationStoreError('成员关系版本已变化', 'ORG_CONFLICT', current.path)
      const value = organizationMembershipSchema.parse({ ...input, id, formatVersion: 1, worldId: this.config.worldId })
      await this.verifyMembership(value, signal); return this.updated('memberships', value, current.version, signal)
    })
  }
  /** 可信查询层扫描并复核文件版本；不提供跨进程原子快照。 */
  snapshot(signal?: AbortSignal): Promise<OrganizationSnapshot> {
    return this.enqueue(async () => {
      const orgs = await this.scan('organizations', parseOrganization, signal)
      const relations = await this.scan('relations', parseOrganizationRelation, signal)
      const members = await this.scan('memberships', parseOrganizationMembership, signal)
      this.validateRelations(orgs, Array.from(relations.values(), entry => entry.document))
      for (const { document } of members.values()) if (!orgs.has(document.organizationId)) throw new OrganizationStoreError('成员关系所属组织不存在', 'ORG_INVALID_DOCUMENT')
      const sort = <T>(values: Iterable<StoredOrganizationDocument<T>>) => Array.from(values).sort((a, b) => a.path.localeCompare(b.path))
      const organizations = sort(orgs.values()); const allRelations = sort(relations.values()); const memberships = sort(members.values())
      for (const [name, entries] of [['organizations', organizations], ['relations', allRelations], ['memberships', memberships]] as const) {
        for (const item of entries) {
          signal?.throwIfAborted()
          const target = await this.target(name, item.document.id)
          if ((await this.config.fs.stat(target, signal))?.version !== item.version) throw new OrganizationStoreError('扫描期间组织文档发生变化', 'ORG_CONFLICT')
        }
        const names = (await this.config.fs.listDir(await this.directory(name), signal)).filter(item => item.name.endsWith('.json')).map(item => item.name).sort()
        if (JSON.stringify(names) !== JSON.stringify(entries.map(item => `${item.document.id}.json`).sort())) throw new OrganizationStoreError('扫描期间组织目录发生变化', 'ORG_CONFLICT')
      }
      return { organizations, relations: allRelations, memberships }
    })
  }
  /** 按可信世界重新核实外部引用；未装配或解析器错误保持显式失败。 */
  checkReference(kind: 'person' | 'place', id: string, signal?: AbortSignal): Promise<{ status: 'verified' | 'not_found' | 'mismatch' }> {
    return this.enqueue(async () => {
      organizationIdSchema.parse(id)
      const resolver = kind === 'person' ? this.config.resolvePerson : this.config.resolvePlace
      if (!resolver) throw new OrganizationStoreError('可信跨模块引用解析器未装配', 'ORG_REFERENCE_UNAVAILABLE')
      signal?.throwIfAborted(); const result = await resolver(id, signal); signal?.throwIfAborted()
      if (!result) return { status: 'not_found' }
      if (result.id !== id || result.worldId !== this.config.worldId) return { status: 'mismatch' }
      return { status: 'verified' }
    })
  }
  /** 拒绝新操作并等待已受理工作，释放进程内占用。 */
  close(): Promise<void> {
    if (!this.closing) { this.closed = true; this.closing = this.tail.then(() => { occupiedWorlds.delete(this.config.worldId); occupiedRoots.delete(this.root.targetKey) }) }
    return this.closing
  }
}
