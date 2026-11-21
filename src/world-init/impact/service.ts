import { createHash, randomUUID } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { parseDocument } from 'yaml'
import { z } from 'zod'
import type { FileSystem } from '@fly-novel/fs'
import { isPathUnder } from '@fly-novel/fs-sandbox'
import { MapStore } from '@fly-novel/map'
import { HistoryQueries, HistoryStore } from '@fly-novel/history'
import { OrganizationQueries, OrganizationStore } from '@fly-novel/organization'
import { parseDiscussionTarget, type DiscussionService } from '../discussion/service.js'
import { validateWorldWorkspaceConfigs, type WorldWorkspaceConfig } from '../workspace/config.js'

const uuid = z.string().uuid()
const sourceSchema = z.object({ kind: z.string(), id: z.string(), version: z.string(), content: z.string() }).strict()
const scopeSchema = z.object({ name: z.string(), status: z.enum(['checked', 'uncovered', 'failed', 'cancelled', 'changed']),
  version: z.string().nullable(), reason: z.string(), sources: z.array(sourceSchema) }).strict()
const reportSchema = z.object({ formatVersion: z.literal(1), worldId: z.string(), discussionId: uuid, id: uuid, createdAt: z.iso.datetime(),
  candidateId: uuid, candidateVersion: z.string(), baseline: z.string(), currentVersion: z.string(), target: z.unknown(),
  currentContent: z.string(), candidateContent: z.string(), candidateSummary: z.string(),
  status: z.enum(['completed', 'failed', 'cancelled', 'changed']), scopes: z.array(scopeSchema) }).strict()
export type ImpactReport = z.infer<typeof reportSchema>
type Scope = z.infer<typeof scopeSchema>
type Owned<T> = { readonly agentId: string; readonly store: T }
const occupiedWorlds = new Set<string>(); const occupiedRoots = new Set<string>()

/** 单世界只读影响线索检查；调用方拥有借用的存储和文件后端。 */
export class ImpactService {
  private tail: Promise<void> = Promise.resolve()
  private closed = false
  private closing?: Promise<void>
  private constructor(private readonly world: WorldWorkspaceConfig, private readonly root: string, private readonly fs: FileSystem,
    private readonly discussion: DiscussionService, private readonly map?: MapStore, private readonly history?: HistoryStore,
    private readonly organization?: OrganizationStore) {}

  get boundWorldId(): string { return this.world.worldId }
  get rootDirectory(): string { return this.root }
  /** 用于可信应用验证报告与讨论服务来自同一装配。 */
  isBoundTo(service: DiscussionService): boolean { return this.discussion === service }

  /**
   * 打开已有报告目录，并核对所有存储和世界负责人绑定。
   * @param options 可信世界、报告根、后端、讨论及按需借用的模块存储。
   * @returns 调用方持有的服务；使用后必须等待 close。
   * @throws 配置、路径、身份不匹配或同世界已打开时拒绝。
   */
  static async open(options: { workspaces: readonly WorldWorkspaceConfig[]; worldId: string; root: string; fs: FileSystem;
    discussion: DiscussionService; singleWriterProcess: true; map?: Owned<MapStore>; history?: Owned<HistoryStore>; organization?: Owned<OrganizationStore> }): Promise<ImpactService> {
    if (options.singleWriterProcess !== true) throw new Error('必须确保单可信写入进程')
    const worlds = await validateWorldWorkspaceConfigs(options.workspaces)
    const world = worlds.find(item => item.worldId === options.worldId)
    if (!world || options.discussion.boundWorldId !== world.worldId) throw new Error('影响检查世界绑定不匹配')
    const valid = (item: { agentId: string; root: string; worldId: string } | undefined) => !item ||
      (item.worldId === world.worldId && world.agents.some(agent => agent.agentId === item.agentId && agent.writableRoot === item.root))
    if (!valid(options.map && { agentId: options.map.agentId, root: options.map.store.rootDirectory, worldId: options.map.store.boundWorldId }) ||
        !valid(options.history && { agentId: options.history.agentId, root: options.history.store.rootDirectory, worldId: options.history.store.worldId }) ||
        !valid(options.organization && { agentId: options.organization.agentId, root: options.organization.store.rootDirectory, worldId: options.organization.store.worldId })) throw new Error('影响检查存储负责人不匹配')
    if (!isAbsolute(options.root) || await realpath(options.root) !== resolve(options.root) || !(await lstat(options.root)).isDirectory()) throw new Error('检查报告根必须是现有真实绝对目录')
    for (const item of worlds) if (await isPathUnder(options.root, item.readRoot) || await isPathUnder(item.readRoot, options.root)) throw new Error('检查报告根不能与世界读取根重叠')
    if (await isPathUnder(options.root, options.discussion.rootDirectory) || await isPathUnder(options.discussion.rootDirectory, options.root)) throw new Error('检查报告根不能与讨论根重叠')
    const root = process.platform === 'win32' ? options.root.toLowerCase() : options.root
    if (occupiedWorlds.has(world.worldId) || occupiedRoots.has(root)) throw new Error('影响检查服务已打开')
    occupiedWorlds.add(world.worldId); occupiedRoots.add(root)
    return new ImpactService(world, root, options.fs, options.discussion, options.map?.store, options.history?.store, options.organization?.store)
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('影响检查服务已关闭'))
    const result = this.tail.then(fn); this.tail = result.then(() => undefined, () => undefined); return result
  }
  private async target(id: string) {
    uuid.parse(id); const path = join(this.root, `${id}.json`); const info = await this.fs.lstat(path)
    if (info && info.type !== 'file') throw new Error('检查报告必须是普通文件')
    const target = await this.fs.resolve(path); const parent = await this.fs.resolve(this.root)
    if (!this.fs.contains(parent, target)) throw new Error('检查报告路径越界')
    return target
  }

  /**
   * 只读采集已记录关联和范围版本；不推断语义冲突。
   * @param discussionId 可信应用绑定的讨论 ID。
   * @param candidateId 属于该讨论的有效候选 ID。
   * @param signal 可选取消信号；取消后的报告仍会记录已知结果。
   * @returns 已保存的报告及其内容摘要。
   * @throws 候选无效、报告超限或发布失败；发布结果不确定时包含核查标识。
   */
  check(discussionId: string, candidateId: string, signal?: AbortSignal): Promise<{ report: ImpactReport; version: string }> { return this.enqueue(async () => {
    const candidate = await this.discussion.readCandidate(candidateId)
    if (candidate.value.discussionId !== discussionId || candidate.value.status !== 'active' || candidate.stale) throw new Error('候选不属于讨论、已放弃或基线过期')
    const target = parseDiscussionTarget(candidate.value.target); const scopes: Scope[] = []
    let status: ImpactReport['status'] = 'completed'
    const uncovered = (name: string, reason: string) => scopes.push({ name, status: 'uncovered', version: null, reason, sources: [] })
    const failed = (name: string, error: unknown, sources: Scope['sources'] = [], version: string | null = null) => {
      const cancelled = signal?.aborted === true; status = cancelled ? 'cancelled' : 'failed'
      scopes.push({ name, status: cancelled ? 'cancelled' : 'failed', version, reason: error instanceof Error ? error.message : String(error), sources })
    }
    if (target.kind === 'place') {
      if (!this.map) uncovered('地图关联', '地图查询未装配')
      else try {
        signal?.throwIfAborted()
        const snapshot = await this.map.snapshot(signal)
        const place = snapshot.places.find(item => item.document.id === target.id)
        if (!place) throw new Error('地点不存在')
        const related = snapshot.connections.filter(item => item.document.fromId === target.id || item.document.toId === target.id)
        const parents = new Set(place.document.parents.flatMap(item => item.parent.kind === 'place' ? [item.parent.id] : []))
        const nearby = snapshot.places.filter(item => parents.has(item.document.id) || item.document.parents.some(parent => parent.parent.kind === 'place' && parent.parent.id === target.id))
        scopes.push({ name: '地图关联', status: 'checked', version: snapshot.version, reason: '仅包含已记录的直接父 / 子地点和直接连通，不判断语义影响',
          sources: [...nearby.map(item => ({ kind: 'place', id: item.document.id, version: item.version, content: JSON.stringify(item.document) })),
            ...related.map(item => ({ kind: 'map-connection', id: item.document.id, version: item.version, content: JSON.stringify(item.document) }))] })
      } catch (error) { failed('地图关联', error) }
      uncovered('人物经历', '人物正文没有结构化地点反向查询，未覆盖未关联的地点经历')
      uncovered('组织与其他资料', '没有按地点覆盖全部模块的反向查询')
    } else if (target.kind === 'character') {
      if (!this.organization) uncovered('组织成员', '组织查询未装配')
      else {
        let version: string | undefined; const sources: Scope['sources'] = []
        try {
        const query = new OrganizationQueries(this.organization, { kind: 'planner', worldId: this.world.worldId })
        let offset = 0
        for (;;) {
          signal?.throwIfAborted()
          const page = await query.memberships({ personId: target.id, offset, limit: 100, ...(version ? { version } : {}) }, signal)
          version = page.version
          for (const item of page.items) sources.push({ kind: 'organization-membership', id: item.document.id, version: item.version, content: JSON.stringify(item.document) })
          if (page.nextOffset === null) break
          offset = page.nextOffset
        }
        const snapshot = await this.organization.snapshot(signal)
        const again = await query.memberships({ personId: target.id, offset: 0, limit: 1, version }, signal)
        scopes.push({ name: '组织成员', status: 'checked', version: again.version, reason: '仅包含已关联该人物的成员记录', sources })
        if (snapshot.memberships.some(item => item.document.person.kind === 'unresolved')) uncovered('未关联成员线索', '未关联人物线索不能按人物 ID 确认归属')
        } catch (error) { failed('组织成员', error, sources, version ?? null) }
      }
      uncovered('人物其他影响', '未检查全部人物经历、人物关系及其他模块的语义影响')
    } else uncovered('目标影响', '该目标的关联检查尚未接入')
    if (status === 'completed' && this.history && (target.kind === 'place' || target.kind === 'character' || target.kind === 'organization')) {
      let version: string | undefined; const sources: Scope['sources'] = []
      try {
        const type = target.kind === 'place' ? 'place' : target.kind === 'character' ? 'person' : 'organization'
        const query = new HistoryQueries(this.history); let offset = 0; let uncertain = false
        for (;;) {
          signal?.throwIfAborted()
          const page = await query.search({ reference: { type, id: target.id }, offset, limit: 100, ...(version ? { version } : {}) }, signal)
          version = page.version; uncertain ||= page.referenceUncertain === true
          for (const item of page.items) {
            const source = await this.history.readEvent(item.id, signal)
            sources.push({ kind: 'history-event', id: source.document.id, version: source.version, content: JSON.stringify(source.document) })
          }
          if (page.nextOffset === null) break
          offset = page.nextOffset
        }
        const again = await query.search({ reference: { type, id: target.id }, offset: 0, limit: 1, version }, signal)
        scopes.push({ name: '历史引用', status: 'checked', version: again.version, reason: '仅包含已记录且已关联目标的历史事件', sources })
        if (uncertain) uncovered('历史未关联线索', '存在同类型未关联线索，不能判断是否涉及目标')
      } catch (error) { failed('历史引用', error, sources, version ?? null) }
    } else if (target.kind === 'place' || target.kind === 'character' || target.kind === 'organization') {
      uncovered('历史引用', status === 'completed' ? '历史查询未装配' : '前一范围失败或取消，未执行历史查询')
    }
    if (signal?.aborted) {
      status = 'cancelled'
      scopes.push({ name: '检查取消', status: 'cancelled', version: null, reason: '检查在完成前取消', sources: [] })
    }
    try {
      const again = await this.discussion.readCandidate(candidateId)
      if (again.value.discussionId !== discussionId || again.value.status !== 'active' || again.version !== candidate.version || again.current.version !== candidate.current.version) {
        status = 'changed'; scopes.push({ name: '候选复核', status: 'changed', version: null, reason: '候选或当前资料在检查期间变化', sources: [] })
      }
    } catch (error) { failed('候选复核', error) }
    const report = reportSchema.parse({ formatVersion: 1, worldId: this.world.worldId, discussionId, id: randomUUID(), createdAt: new Date().toISOString(), candidateId,
      candidateVersion: candidate.version, baseline: candidate.value.baseline, currentVersion: candidate.current.version, target,
      currentContent: candidate.current.content, candidateContent: candidate.value.content, candidateSummary: candidate.value.summary, status, scopes })
    const text = `${JSON.stringify(report, null, 2)}\n`
    if (Buffer.byteLength(text, 'utf8') > 8 * 1024 * 1024) throw new Error('检查报告超出大小限制')
    try { await this.fs.writeText(await this.target(report.id), text, { kind: 'createIfAbsent' }) }
    catch (error) { throw new Error(`检查报告发布结果不确定：${report.id}`, { cause: error }) }
    return { report, version: createHash('sha256').update(text).digest('hex') }
  }) }

  private async readReport(discussionId: string, id: string): Promise<{ report: ImpactReport; version: string }> {
    const target = await this.target(id); const before = await this.fs.stat(target)
    if (!before || before.type !== 'file') throw new Error('检查报告不存在')
    const bytes = await this.fs.readBytes(target, undefined, 8 * 1024 * 1024)
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (parseDocument(text, { uniqueKeys: true }).errors.length) throw new Error('检查报告格式无效')
    const report = reportSchema.parse(JSON.parse(text)); parseDiscussionTarget(report.target)
    const after = await this.fs.stat(target)
    if (!after || before.version !== after.version) throw new Error('检查报告读取期间变化')
    if (report.worldId !== this.world.worldId || report.discussionId !== discussionId || report.id !== id) throw new Error('检查报告身份不匹配')
    return { report, version: createHash('sha256').update(bytes).digest('hex') }
  }

  /**
   * 按可信讨论读取已保存报告。
   * @param discussionId 可信讨论 ID。
   * @param id 报告 ID。
   * @returns 报告及其内容摘要。
   * @throws 记录缺失、损坏、未知版本或身份不匹配时拒绝。
   */
  read(discussionId: string, id: string): Promise<{ report: ImpactReport; version: string }> { return this.enqueue(() => this.readReport(discussionId, id)) }

  /**
   * 重查报告所记录的候选和已检查范围，不提供跨文件锁或提交授权。
   * @param discussionId 可信讨论 ID。
   * @param id 报告 ID。
   * @param expectedVersion 用户审阅的报告内容摘要。
   * @param signal 可选取消信号。
   * @returns 当前、已变化或复核失败及原因；未覆盖范围不因此成为已检查。
   */
  verify(discussionId: string, id: string, expectedVersion: string, signal?: AbortSignal): Promise<{ status: 'current' | 'changed' | 'failed'; reason: string }> { return this.enqueue(async () => {
    try {
      const stored = await this.readReport(discussionId, id)
      if (stored.version !== expectedVersion || stored.report.status !== 'completed') return { status: 'changed', reason: '报告已变化或检查未完成' }
      const report = stored.report; const target = parseDiscussionTarget(report.target)
      if (report.scopes.some(scope => ['failed', 'cancelled', 'changed'].includes(scope.status))) return { status: 'failed', reason: '检查报告包含未完成范围' }
      const candidate = await this.discussion.readCandidate(report.candidateId)
      if (candidate.value.discussionId !== discussionId || candidate.value.status !== 'active' || candidate.stale ||
          candidate.version !== report.candidateVersion || candidate.current.version !== report.currentVersion || candidate.value.baseline !== report.baseline ||
          JSON.stringify(candidate.value.target) !== JSON.stringify(target) || candidate.value.content !== report.candidateContent || candidate.current.content !== report.currentContent || candidate.value.summary !== report.candidateSummary) return { status: 'changed', reason: '候选或当前资料已变化' }
      for (const scope of report.scopes) {
        signal?.throwIfAborted()
        if (scope.status !== 'checked') continue
        if (!scope.version) return { status: 'failed', reason: '已检查范围缺少版本' }
        if (scope.name === '地图关联' && target.kind === 'place' && this.map) {
          if ((await this.map.snapshot(signal)).version !== scope.version) return { status: 'changed', reason: '地图范围已变化' }
        } else if (scope.name === '组织成员' && target.kind === 'character' && this.organization) {
          const query = new OrganizationQueries(this.organization, { kind: 'planner', worldId: this.world.worldId })
          await query.memberships({ personId: target.id, offset: 0, limit: 1, version: scope.version }, signal)
        } else if (scope.name === '历史引用' && this.history && (target.kind === 'place' || target.kind === 'character' || target.kind === 'organization')) {
          const type = target.kind === 'place' ? 'place' : target.kind === 'character' ? 'person' : 'organization'
          await new HistoryQueries(this.history).search({ reference: { type, id: target.id }, offset: 0, limit: 1, version: scope.version }, signal)
        } else return { status: 'failed', reason: '报告包含无法复核的检查范围' }
      }
      return { status: 'current', reason: '已检查范围和候选版本未变化；未覆盖范围仍未检查' }
    } catch (error) {
      if (error instanceof Error && 'code' in error && ['ORG_CONFLICT', 'HISTORY_CONFLICT', 'MAP_CONFLICT'].includes(String(error.code))) return { status: 'changed', reason: error.message }
      return { status: 'failed', reason: error instanceof Error ? error.message : String(error) }
    }
  }) }

  /** 停止新请求并等待已受理检查，释放进程内占用。 */
  close(): Promise<void> {
    if (!this.closing) { this.closed = true; this.closing = (async () => { await this.tail; occupiedWorlds.delete(this.world.worldId); occupiedRoots.delete(this.root) })() }
    return this.closing
  }
}
