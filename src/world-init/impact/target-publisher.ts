import { createHash } from 'node:crypto'
import { join, relative, sep } from 'node:path'
import { LocalFileSystem } from '@fly-novel/fs-local'
import { formatOrganizationDocument, parseOrganization, parseOrganizationRelation, parseOrganizationMembership, type OrganizationStore } from '@fly-novel/organization'
import { formatHistoryEvent, parseHistoryEvent, type HistoryStore } from '@fly-novel/history'
import { formatCharacterRelationship, parseCharacterRelationship, formatCharacterDocument, parseCharacterDocument, type CharacterStore, type CharacterRelationshipStore } from '@fly-novel/character'
import { formatMapDocument, parseMapPlace, type MapStore } from '@fly-novel/map'
import { parseJson, startSchema, overviewSchema, situationSchema, type SituationStore } from '@fly-novel/initial-situation'
import { parseDocumentJson, documentSchema, contentSchema, type DevelopmentStore } from '@fly-novel/world-development'
import { parseSpecificJson, specificDocumentSchema, specificContentSchema, type SpecificStore } from '@fly-novel/world-specific'
import { resolveCatalogTarget } from '../workspace/catalog/path.js'
import { readCatalog } from '../workspace/catalog/format.js'
import { sameWorldWorkspace, validateWorldWorkspaceConfigs, type WorldWorkspaceConfig } from '../workspace/config.js'
import type { DiscussionTarget } from '../discussion/service.js'

const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
type Owned<T> = { agentId: string; store: T }
type PublisherOptions = { map?: Owned<MapStore>; characters?: Owned<CharacterStore>; organization?: Owned<OrganizationStore>;
  history?: Owned<HistoryStore>; relationships?: Owned<CharacterRelationshipStore>; situation?: Owned<SituationStore>;
  development?: Owned<DevelopmentStore>; specific?: Owned<SpecificStore> }

/** 由可信应用装配的扩展目标发布器；不接收模型选择的负责人或路径。 */
export class TargetPublisher {
  get boundWorldId(): string { return this.world.worldId }
  get boundWorldRoot(): string { return this.world.readRoot }
  /** 比较完整世界及负责人绑定，避免同名世界配置被混用。 */
  isBoundTo(world: WorldWorkspaceConfig): boolean {
    return sameWorldWorkspace(this.world, world)
  }
  private constructor(private readonly world: WorldWorkspaceConfig, private readonly fs: LocalFileSystem, private readonly options: PublisherOptions) {
    for (const item of [options.organization, options.history, options.situation, options.development, options.specific]) {
      if (item && (!item.store.writable || item.store.worldId !== world.worldId || !(item.store.fileSystem instanceof LocalFileSystem) ||
        !world.agents.some(agent => agent.agentId === item.agentId && agent.writableRoot === item.store.rootDirectory))) throw new Error('发布存储与世界负责人不匹配')
    }
    if (!(fs instanceof LocalFileSystem)) throw new Error('文件发布仅支持已协调的本机后端')
    if (options.map && (!options.map.store.writable || options.map.store.boundWorldId !== world.worldId || !(options.map.store.fileSystem instanceof LocalFileSystem) || !world.agents.some(agent => agent.agentId === options.map!.agentId && agent.writableRoot === options.map!.store.rootDirectory))) throw new Error('地图存储与负责人不匹配')
    if (options.characters && !world.agents.some(agent => agent.agentId === options.characters!.agentId && agent.writableRoot === options.characters!.store.rootDirectory)) throw new Error('人物存储与负责人不匹配')
    if (options.relationships && (options.relationships.store.worldId !== world.worldId || !world.agents.some(agent => agent.agentId === options.relationships!.agentId &&
      options.relationships!.store.rootDirectory === join(agent.writableRoot, 'relationships')))) throw new Error('人物关系存储与负责人不匹配')
  }

  /** 校验并固定世界和负责人配置；调用方持有所有借用的存储。 */
  static async create(world: WorldWorkspaceConfig, fs: LocalFileSystem, options: PublisherOptions): Promise<TargetPublisher> {
    const [validated] = await validateWorldWorkspaceConfigs([world])
    if (!validated) throw new Error('发布世界配置无效')
    const snapshot = { ...options, ...(options.map ? { map: { ...options.map } } : {}), ...(options.characters ? { characters: { ...options.characters } } : {}),
      ...(options.organization ? { organization: { ...options.organization } } : {}), ...(options.history ? { history: { ...options.history } } : {}),
      ...(options.relationships ? { relationships: { ...options.relationships } } : {}), ...(options.situation ? { situation: { ...options.situation } } : {}),
      ...(options.development ? { development: { ...options.development } } : {}), ...(options.specific ? { specific: { ...options.specific } } : {}) }
    return new TargetPublisher(validated, fs, snapshot)
  }

  /** 将候选转换为保持当前状态的最终正文；不会写入资料。 */
  async preview(target: DiscussionTarget, content: string): Promise<string> {
    switch (target.kind) {
      case 'place': {
        if (!this.options.map) throw new Error('地图发布未装配')
        const doc = parseMapPlace(content); if (doc.id !== target.id || doc.worldId !== this.world.worldId) throw new Error('地点候选身份不匹配')
        await this.options.map.store.validatePlaceCandidate(doc); return formatMapDocument(doc)
      }
      case 'character': {
        if (!this.options.characters) throw new Error('人物发布未装配')
        const doc = parseCharacterDocument(content); if (doc.metadata.id !== target.id || doc.metadata.contentStatus !== 'pending') throw new Error('人物候选身份不匹配')
        const current = await this.options.characters.store.readVersioned(target.id)
        return formatCharacterDocument({ ...doc, metadata: { ...doc.metadata, contentStatus: current.document.metadata.contentStatus } })
      }
      case 'organization': { if (!this.options.organization) throw new Error('组织发布未装配'); const doc = parseOrganization(content); if (doc.id !== target.id || doc.worldId !== this.world.worldId) throw new Error('组织候选身份不匹配'); await this.options.organization.store.validateOrganizationCandidate(doc); return formatOrganizationDocument(doc) }
      case 'organization-relation': { if (!this.options.organization) throw new Error('组织发布未装配'); const doc = parseOrganizationRelation(content); if (doc.id !== target.id || doc.worldId !== this.world.worldId) throw new Error('组织关系候选身份不匹配'); await this.options.organization.store.validateRelationCandidate(doc); return formatOrganizationDocument(doc) }
      case 'organization-membership': { if (!this.options.organization) throw new Error('组织发布未装配'); const doc = parseOrganizationMembership(content); if (doc.id !== target.id || doc.worldId !== this.world.worldId) throw new Error('成员候选身份不匹配'); await this.options.organization.store.validateMembershipCandidate(doc); return formatOrganizationDocument(doc) }
      case 'history-event': {
        if (!this.options.history) throw new Error('历史发布未装配')
        const doc = parseHistoryEvent(content); if (doc.id !== target.id || doc.worldId !== this.world.worldId || doc.contentStatus !== 'suggested') throw new Error('历史候选身份不匹配')
        await this.options.history.store.validateEventCandidate(doc); const current = await this.options.history.store.readEvent(target.id)
        return formatHistoryEvent({ ...doc, contentStatus: current.document.contentStatus })
      }
      case 'character-relationship': {
        if (!this.options.relationships) throw new Error('人物关系发布未装配')
        const doc = parseCharacterRelationship(content); if (doc.id !== target.id || doc.worldId !== this.world.worldId || doc.contentStatus !== 'suggested') throw new Error('人物关系候选身份不匹配')
        await this.options.relationships.store.validateCandidate(doc); const current = await this.options.relationships.store.read(target.id)
        return formatCharacterRelationship({ ...doc, contentStatus: current.document.contentStatus })
      }
      case 'situation-start': { if (!this.options.situation) throw new Error('局势发布未装配'); const doc = parseJson(content, startSchema); if (doc.worldId !== this.world.worldId) throw new Error('起点候选身份不匹配'); await this.options.situation.store.readStart(); return json(doc) }
      case 'situation': {
        if (!this.options.situation) throw new Error('局势发布未装配')
        const doc = target.documentKind === 'overview' ? parseJson(content, overviewSchema) : parseJson(content, situationSchema)
        if (doc.id !== target.id || doc.worldId !== this.world.worldId || doc.contentStatus !== 'suggested') throw new Error('局势候选身份不匹配')
        await this.options.situation.store.validateCandidate(target.documentKind, doc)
        const current = target.documentKind === 'overview' ? await this.options.situation.store.readOverview(target.id) : await this.options.situation.store.readSituation(target.id)
        return json({ ...doc, contentStatus: current.document.contentStatus })
      }
      case 'development': {
        if (!this.options.development) throw new Error('规划发布未装配')
        const doc = parseDocumentJson(content, documentSchema)
        if (doc.id !== target.id || doc.worldId !== this.world.worldId || doc.kind !== target.documentKind || doc.contentStatus !== 'suggested') throw new Error('规划候选身份不匹配')
        await this.options.development.store.validateCandidate(doc); const current = await this.options.development.store.readDocument(target.documentKind, target.id)
        return json({ ...doc, contentStatus: current.document.contentStatus })
      }
      case 'specific': {
        if (!this.options.specific) throw new Error('专有内容发布未装配')
        const doc = parseSpecificJson(content, specificDocumentSchema)
        if (doc.id !== target.id || doc.worldId !== this.world.worldId || doc.kind !== target.documentKind || doc.contentStatus !== 'suggested') throw new Error('专有内容候选身份不匹配')
        await this.options.specific.store.validateCandidate(doc); const current = await this.options.specific.store.readDocument(target.documentKind, target.id)
        return json({ ...doc, contentStatus: current.document.contentStatus })
      }
      case 'file': {
        if (content.includes('\0')) throw new Error('文件内容含空字符')
        const source = await resolveCatalogTarget(this.world, target.ownerAgentId, target.path)
        if (source.path !== target.path) throw new Error('文件目标路径不规范')
        return content
      }
      default: throw new Error('目标由其他发布器处理')
    }
  }

  /** 条件发布已有目标，重新执行所属模块的引用和图约束。 */
  async publish(target: DiscussionTarget, content: string, version: string, signal?: AbortSignal): Promise<void> {
    await this.preview(target, content)
    switch (target.kind) {
      case 'place': {
        if (!this.options.map) throw new Error('地图发布未装配')
        const current = await this.options.map.store.readPlace(target.id)
        if (current.version !== version) throw new Error('地点基线已变化')
        await this.options.map.store.publishPlaceCandidate(parseMapPlace(content), current.version, signal); return
      }
      case 'character': {
        if (!this.options.characters) throw new Error('人物发布未装配')
        const doc = parseCharacterDocument(content)
        const { id, formatVersion: _format, contentStatus: _status, ...input } = doc.metadata
        await this.options.characters.store.publishReviewed(id, version, { ...input, body: doc.body }, signal); return
      }
      case 'organization': {
        if (!this.options.organization) throw new Error('组织发布未装配')
        const { id, worldId: _world, formatVersion: _format, reviewStatus: _status, ...input } = parseOrganization(content)
        await this.options.organization.store.updateOrganization(id, version, input, signal); return
      }
      case 'organization-relation': {
        if (!this.options.organization) throw new Error('组织发布未装配')
        const { id, worldId: _world, formatVersion: _format, ...input } = parseOrganizationRelation(content)
        await this.options.organization.store.updateRelation(id, version, input, signal); return
      }
      case 'organization-membership': {
        if (!this.options.organization) throw new Error('组织发布未装配')
        const { id, worldId: _world, formatVersion: _format, ...input } = parseOrganizationMembership(content)
        await this.options.organization.store.updateMembership(id, version, input, signal); return
      }
      case 'history-event': {
        if (!this.options.history) throw new Error('历史发布未装配')
        const { id, worldId: _world, formatVersion: _format, contentStatus: _status, ...input } = parseHistoryEvent(content)
        await this.options.history.store.publishReviewed(id, version, input, signal); return
      }
      case 'character-relationship': {
        if (!this.options.relationships) throw new Error('人物关系发布未装配')
        const doc = parseCharacterRelationship(content)
        await this.options.relationships.store.publishReviewed(doc.id, version, { participants: doc.participants, relations: doc.relations }, signal); return
      }
      case 'situation-start': {
        if (!this.options.situation) throw new Error('局势发布未装配')
        await this.options.situation.store.updateStart(version, parseJson(content, startSchema).description, signal); return
      }
      case 'situation': {
        if (!this.options.situation) throw new Error('局势发布未装配')
        const doc = target.documentKind === 'overview' ? parseJson(content, overviewSchema) : parseJson(content, situationSchema)
        const { id, worldId: _world, formatVersion: _format, contentStatus: _status, ...input } = doc
        await this.options.situation.store.publishReviewed(target.documentKind, id, version, input, signal); return
      }
      case 'development': {
        if (!this.options.development) throw new Error('规划发布未装配')
        const doc = parseDocumentJson(content, documentSchema)
        const { id, kind, worldId: _world, formatVersion: _format, contentStatus: _status, ...input } = doc
        await this.options.development.store.publishReviewed(kind, id, version, contentSchema.parse(input), signal); return
      }
      case 'specific': {
        if (!this.options.specific) throw new Error('专有内容发布未装配')
        const doc = parseSpecificJson(content, specificDocumentSchema)
        const { id, kind, worldId: _world, formatVersion: _format, contentStatus: _status, ...input } = doc
        await this.options.specific.store.publishReviewed(kind, id, version, specificContentSchema.parse(input), signal); return
      }
      case 'file': {
        const source = await resolveCatalogTarget(this.world, target.ownerAgentId, target.path)
        if (source.path !== target.path) throw new Error('文件目标路径不规范')
        const file = await this.fs.resolve(source.absolutePath); const before = await this.fs.stat(file)
        if (!before || before.type !== 'file') throw new Error('文件不存在')
        const bytes = await this.fs.readBytes(file, signal, 1024 * 1024)
        if (digest(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) !== version) throw new Error('文件基线已变化')
        await this.fs.writeText(file, content, { kind: 'replaceIfVersion', version: before.version }, signal); return
      }
      default: throw new Error('目标由其他发布器处理')
    }
  }

  /** 人物正文与索引中断时，仅按预期摘要调用现有恢复入口。 */
  async recoverCharacter(target: DiscussionTarget, baseline: string, afterDigest: string): Promise<void> {
    if (target.kind !== 'character' || !this.options.characters) throw new Error('该目标没有人物索引恢复能力')
    await this.options.characters.store.recoverInitialization(target.id, { baseline, candidate: afterDigest })
  }

  /** 核对目录登记与实际文件摘要；不改写或臆造目录简介。 */
  async catalogStatus(target: DiscussionTarget): Promise<'not-configured' | 'unregistered' | 'current' | 'stale'> {
    const directory = await this.fs.lstat(join(this.world.catalogRoot, 'catalog.json'))
    if (!directory) return 'not-configured'
    if (directory.type !== 'file') throw new Error('目录记录不是普通文件')
    let absolute: string
    switch (target.kind) {
      case 'place': if (!this.options.map) throw new Error('地图发布未装配'); absolute = join(this.options.map.store.rootDirectory, 'places', `${target.id}.json`); break
      case 'character': if (!this.options.characters) throw new Error('人物发布未装配'); absolute = join(this.options.characters.store.rootDirectory, target.id, 'profile.md'); break
      case 'character-relationship': if (!this.options.relationships) throw new Error('人物关系发布未装配'); absolute = join(this.options.relationships.store.rootDirectory, `${target.id}.json`); break
      case 'organization': if (!this.options.organization) throw new Error('组织发布未装配'); absolute = join(this.options.organization.store.rootDirectory, 'organizations', `${target.id}.json`); break
      case 'organization-relation': if (!this.options.organization) throw new Error('组织发布未装配'); absolute = join(this.options.organization.store.rootDirectory, 'relations', `${target.id}.json`); break
      case 'organization-membership': if (!this.options.organization) throw new Error('组织发布未装配'); absolute = join(this.options.organization.store.rootDirectory, 'memberships', `${target.id}.json`); break
      case 'history-event': if (!this.options.history) throw new Error('历史发布未装配'); absolute = join(this.options.history.store.rootDirectory, 'events', `${target.id}.json`); break
      case 'situation-start': if (!this.options.situation) throw new Error('局势发布未装配'); absolute = join(this.options.situation.store.rootDirectory, 'start.json'); break
      case 'situation': if (!this.options.situation) throw new Error('局势发布未装配'); absolute = join(this.options.situation.store.rootDirectory, target.documentKind === 'overview' ? 'overviews' : 'situations', `${target.id}.json`); break
      case 'development': if (!this.options.development) throw new Error('规划发布未装配'); absolute = join(this.options.development.store.rootDirectory, (await this.options.development.store.readDocument(target.documentKind, target.id)).path); break
      case 'specific': if (!this.options.specific) throw new Error('专有内容发布未装配'); absolute = join(this.options.specific.store.rootDirectory, (await this.options.specific.store.readDocument(target.documentKind, target.id)).path); break
      case 'file': absolute = (await resolveCatalogTarget(this.world, target.ownerAgentId, target.path)).absolutePath; break
    }
    const path = relative(this.world.readRoot, absolute).split(sep).join('/')
    const document = await readCatalog(this.world, 16 * 1024 * 1024)
    const entry = document.records.find(item => process.platform === 'win32' ? item.path.toLowerCase() === path.toLowerCase() : item.path === path)
    if (!entry) return 'unregistered'
    const source = await resolveCatalogTarget(this.world, entry.ownerAgentId, entry.path)
    const file = await this.fs.resolve(source.absolutePath); const before = await this.fs.stat(file)
    if (!before || before.type !== 'file') throw new Error('目录指向的成果不存在')
    const bytes = await this.fs.readBytes(file, undefined, 1024 * 1024); const after = await this.fs.stat(file)
    if (!after || before.version !== after.version) throw new Error('目录成果检查期间发生变化')
    return createHash('sha256').update(bytes).digest('hex') === entry.contentSha256 ? 'current' : 'stale'
  }
}
