import { createHash } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { parseDocument } from 'yaml'
import { z } from 'zod'
import type { FsVersion } from '@fly-novel/fs'
import { LocalFileSystem } from '@fly-novel/fs-local'
import type { WorldAccess } from '@fly-novel/util'
import { candidateSchema, parseDiscussionTarget, type DiscussionTarget, type DiscussionTargetAdapter } from '../discussion/service.js'
import { impactReportSchema, type ImpactService } from '../impact/service.js'
import { confirmationSchema, reviewSchema } from '../impact/review.js'
import { operationSchema } from '../impact/commit.js'
import { batchSchema } from '../impact/batch-commit.js'
import { sameWorldWorkspace, validateWorldWorkspaceConfigs, type WorldWorkspaceConfig } from '../workspace/config.js'
import { discoverInitialization, pageDiscovery, type DiscoveryRoot, type DiscoverySnapshot } from './discovery.js'
import type { InitializationTaskStore } from './task-store.js'

const uuid = z.string().uuid()
const artifact = z.object({ target: z.unknown(), version: z.string().min(1), content: z.string(), digest: z.string().length(64) }).strict()
const deferred = z.object({ id: uuid, version: z.string().min(1), target: z.unknown(), summary: z.string().min(1) }).strict()
const deliveryReviewSchema = z.object({ formatVersion: z.literal(1), id: uuid, worldId: z.string().min(1), taskId: uuid, judgmentId: uuid,
  createdAt: z.iso.datetime(), requestDigest: z.string().length(64), discoveryDigest: z.string().length(64), discovery: z.unknown(),
  judgmentVersion: z.string().min(1), artifacts: z.array(artifact).min(1), deferred: z.array(deferred), reportIds: z.array(uuid),
  uncovered: z.array(z.string().min(1)), notes: z.array(z.string().trim().min(1)) }).strict()
const deliverySchema = z.object({ formatVersion: z.literal(1), id: uuid, worldId: z.string().min(1), taskId: uuid, reviewId: uuid,
  reviewVersion: z.string().min(1), createdAt: z.iso.datetime(), deferredCandidateIds: z.array(uuid), acknowledgedUncovered: z.array(z.string().min(1)),
  review: deliveryReviewSchema }).strict()
type DeliveryReview = z.infer<typeof deliveryReviewSchema>
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const unique = (items: readonly string[]) => new Set(items).size === items.length
const sameSet = (left: readonly string[], right: readonly string[]) => unique(left) && unique(right) && left.length === right.length && left.every(item => right.includes(item))
const occupied = new Set<string>()

/** 可信应用持有的最终审阅与不可变交付记录；不注册给模型工具。 */
export class InitializationDelivery {
  private closed = false
  private closing?: Promise<void>
  private constructor(private readonly worlds: readonly WorldWorkspaceConfig[], private readonly world: WorldWorkspaceConfig,
    private readonly roots: Record<DiscoveryRoot, string>, private readonly sessionRoots: readonly string[], private readonly fs: LocalFileSystem,
    private readonly rootKey: string, private readonly gate: WorldAccess, private readonly adapter: DiscussionTargetAdapter, private readonly tasks: InitializationTaskStore,
    private readonly impact: ImpactService) {}

  static async open(options: { worlds: readonly WorldWorkspaceConfig[]; worldId: string; roots: Record<DiscoveryRoot, string>; sessionRoots: readonly string[];
    fs: LocalFileSystem; gate: WorldAccess; adapter: DiscussionTargetAdapter; tasks: InitializationTaskStore; impact: ImpactService; singleWriterProcess: true }) {
    const worlds = await validateWorldWorkspaceConfigs(options.worlds); const world = worlds.find(item => item.worldId === options.worldId)
    if (!world || options.singleWriterProcess !== true || !(options.fs instanceof LocalFileSystem) || !options.adapter.worldBinding ||
      !sameWorldWorkspace(options.adapter.worldBinding, world) || !options.tasks.isBoundToRecovery(world, options.gate) || !options.impact.isBoundToWorld(world)) throw new Error('交付服务世界绑定无效')
    const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
    if (!samePath(options.roots.task, options.tasks.rootDirectory) || !samePath(options.roots.impact, options.impact.rootDirectory)) throw new Error('交付业务根与服务不匹配')
    for (const path of [world.readRoot, ...Object.values(options.roots)]) if (!options.gate.covers(path)) throw new Error('交付协调范围不完整')
    await discoverInitialization({ worlds, worldId: world.worldId, roots: options.roots, sessionRoots: options.sessionRoots })
    const root = options.roots.delivery
    if (!isAbsolute(root) || await realpath(root) !== resolve(root) || !(await lstat(root)).isDirectory()) throw new Error('交付根必须是现有真实目录')
    for (const name of ['reviews', 'deliveries']) {
      const path = join(root, name); const info = await lstat(path)
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) throw new Error('交付子目录必须是现有真实目录')
    }
    const key = process.platform === 'win32' ? root.toLowerCase() : root
    if (occupied.has(key)) throw new Error('交付根已打开')
    occupied.add(key)
    return new InitializationDelivery(worlds, world, { ...options.roots }, [...options.sessionRoots], options.fs, key, options.gate, options.adapter, options.tasks, options.impact)
  }
  get rootDirectory(): string { return this.roots.delivery }
  isBoundTo(world: WorldWorkspaceConfig, gate: WorldAccess, tasks: InitializationTaskStore, impact: ImpactService): boolean {
    return sameWorldWorkspace(this.world, world) && this.gate === gate && this.tasks === tasks && this.impact === impact
  }
  private check(): void { if (this.closed || this.closing) throw new Error('交付服务已关闭') }
  private async file(folder: 'reviews' | 'deliveries', id: string) {
    uuid.parse(id); const path = join(this.roots.delivery, folder, `${id}.json`); const info = await this.fs.lstat(path)
    if (info && info.type !== 'file') throw new Error('交付记录必须是普通文件')
    const target = await this.fs.resolve(path)
    if (!this.fs.contains(await this.fs.resolve(join(this.roots.delivery, folder)), target)) throw new Error('交付路径越界')
    return target
  }
  private async read<T>(folder: 'reviews' | 'deliveries', id: string, schema: z.ZodType<T>): Promise<{ value: T; version: FsVersion }> {
    const target = await this.file(folder, id); const before = await this.fs.stat(target)
    if (!before || before.type !== 'file') throw new Error('交付记录不存在')
    const text = new TextDecoder('utf-8', { fatal: true }).decode(await this.fs.readBytes(target, undefined, 16 * 1024 * 1024))
    if (parseDocument(text, { uniqueKeys: true }).errors.length) throw new Error('交付记录格式无效')
    const value = schema.parse(JSON.parse(text)); const after = await this.fs.stat(target)
    if (!after || before.version !== after.version) throw new Error('交付记录读取期间发生变化')
    return { value, version: after.version }
  }
  private async save<T>(folder: 'reviews' | 'deliveries', id: string, value: T): Promise<{ value: T; version: FsVersion }> {
    const text = `${JSON.stringify(value, null, 2)}\n`
    if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw new Error('交付记录超过 16 MiB 限制')
    try { return { value, version: (await this.fs.writeText(await this.file(folder, id), text, { kind: 'createIfAbsent' })).version } }
    catch (error) { throw new Error(`交付记录写入结果不确定：${folder}/${id}.json`, { cause: error }) }
  }
  private async snapshot() {
    const snapshot = await discoverInitialization({ worlds: this.worlds, worldId: this.world.worldId, roots: this.roots, sessionRoots: this.sessionRoots })
    if (snapshot.scopes.some(scope => scope.status !== 'complete') || snapshot.issues.length) throw new Error('业务记录发现不完整或身份冲突，不能交付')
    return snapshot
  }
  private async verifyConflicts(snapshot: DiscoverySnapshot) {
    const records = (kind: string) => snapshot.entries.filter(entry => entry.kind === kind && entry.status === 'valid').map(entry => entry.record)
    const candidates = records('candidate').map(item => candidateSchema.parse(item))
    for (const candidate of candidates) if (candidate.status === 'publishing') throw new Error(`候选 ${candidate.id} 发布结果尚未核查`)
    for (const item of records('commit')) {
      const operation = operationSchema.parse(item)
      if (!candidates.some(candidate => candidate.id === operation.candidateId)) throw new Error('单项发布缺少候选记录')
      if (!['committed', 'failed'].includes(operation.phase)) throw new Error(`单项发布 ${operation.id} 尚未核查`)
    }
    for (const value of records('batch')) {
      const batch = batchSchema.parse(value)
      if (batch.state === 'running' || batch.items.some(item => !candidates.some(candidate => candidate.id === item.candidateId) ||
        ['locking', 'publishing', 'published'].includes(item.phase) || item.catalogStatus === 'failed' || (item.phase === 'committed' && item.catalogStatus === 'pending'))) throw new Error(`批次 ${batch.id} 存在未核查结果`)
    }
    for (const value of records('impact')) {
      const report = impactReportSchema.parse(value); const candidate = candidates.find(item => item.id === report.candidateId)
      if (!candidate) throw new Error(`影响报告 ${report.id} 缺少候选`)
      if (candidate.status === 'active' && (report.status !== 'completed' || report.scopes.some(scope => ['failed', 'cancelled', 'changed'].includes(scope.status)))) throw new Error(`活动候选的影响报告 ${report.id} 未完成`)
    }
    const confirmations = records('confirmation').map(value => confirmationSchema.parse(value))
    for (const value of records('review')) {
      const review = reviewSchema.parse(value)
      for (const finding of review.findings.filter(item => item.severity === 'important')) {
        const confirmation = confirmations.find(item => item.reviewId === review.id && item.discussionId === review.discussionId)
        const choice = confirmation?.choices.find(item => item.findingId === finding.id)
        const option = finding.options.find(item => item.id === choice?.optionId && item.resolves)
        const reviewVersion = snapshot.entries.find(entry => entry.kind === 'review' && entry.name === review.id + '.json')?.version
        if (!confirmation || confirmation.reviewVersion !== reviewVersion || !option || !option.candidateIds.length || option.candidateIds.some(id => !confirmation.selectedCandidateIds.includes(id))) throw new Error(`重要冲突 ${finding.id} 尚未处理`)
        for (const id of option.candidateIds) {
          const candidate = candidates.find(item => item.id === id)
          if (!candidate || candidate.status !== 'committed' || this.adapter.isTargetBoundToWorld?.(candidate.target, this.world) !== true) throw new Error(`重要冲突 ${finding.id} 的处理尚未发布`)
          const current = await this.adapter.read(candidate.target)
          if (current.content !== candidate.content) throw new Error(`重要冲突 ${finding.id} 的处理结果已变化`)
        }
      }
    }
    return candidates
  }
  private async checkedReports(snapshot: DiscoverySnapshot, ids: readonly string[]) {
    if (!unique(ids)) throw new Error('影响报告重复')
    const reports = snapshot.entries.filter(item => item.kind === 'impact' && item.status === 'valid').map(item => impactReportSchema.parse(item.record))
    const uncovered: string[] = ['未对全部世界资料开展语义一致性检查', '旧模块候选和未选人物索引不在自动发现范围', '未选世界正文未扫描', '资料目录及登记成果状态未在交付中复核']
    for (const report of reports.filter(item => !ids.includes(item.id))) uncovered.push('报告 ' + report.id + ' 未纳入本次复核')
    for (const id of ids) {
      const report = reports.find(item => item.id === id)
      if (!report || report.status !== 'completed' || report.scopes.some(scope => ['failed', 'changed', 'cancelled'].includes(scope.status))) throw new Error('选定的影响报告缺失或未完成')
      const original = await this.impact.read(report.discussionId, report.id)
      const verification = await this.impact.verify(report.discussionId, report.id, original.version)
      if (verification.status !== 'current') throw new Error('选定的影响报告已失效或无法复核')
      for (const scope of report.scopes.filter(item => item.status === 'uncovered')) uncovered.push(`报告 ${id}：${scope.name}`)
    }
    return [...new Set(uncovered)]
  }
  /** 生成不可变的审阅快照，包含真实正文和已发现的业务记录。 */
  prepare(input: { id: string; taskId: string; judgmentId: string; createdAt: string; targets: readonly DiscussionTarget[]; reportIds: readonly string[]; notes: readonly string[] }) {
    this.check()
    return this.gate.run(async () => {
      if (this.closed) throw new Error('交付服务已关闭')
      const normalized = { ...input, targets: input.targets.map(parseDiscussionTarget), reportIds: [...input.reportIds], notes: [...input.notes] }
      const requestDigest = hash(JSON.stringify(normalized)); uuid.parse(input.id)
      if (await this.fs.stat(await this.file('reviews', input.id))) {
        const saved = await this.read('reviews', input.id, deliveryReviewSchema)
        if (saved.value.id !== input.id || saved.value.worldId !== this.world.worldId || saved.value.requestDigest !== requestDigest) throw new Error('审阅身份已用于不同请求')
        return saved
      }
      const first = await this.tasks.readFirstVersion(input.taskId, input.judgmentId)
      if (first.artifacts.some(item => item.status !== 'current')) throw new Error('第一版依据已变化或不可读取')
      const keys = normalized.targets.map(target => JSON.stringify(target))
      if (!keys.length || !unique(keys)) throw new Error('交付成果为空或重复')
      if (first.value.artifacts.some(item => !keys.includes(JSON.stringify(parseDiscussionTarget(item.target))))) throw new Error('交付范围遗漏第一版依据')
      const snapshot = await this.snapshot(); const candidates = await this.verifyConflicts(snapshot)
      const uncovered = await this.checkedReports(snapshot, normalized.reportIds)
      const artifacts = []
      for (const target of normalized.targets) {
        if (this.adapter.isTargetBoundToWorld?.(target, this.world) !== true) throw new Error('交付成果不属于所选世界')
        const current = await this.adapter.read(target)
        artifacts.push({ target, version: current.version, content: current.content, digest: hash(current.content) })
      }
      const active = candidates.filter(item => item.status === 'active').map(item => {
        const entry = snapshot.entries.find(value => value.kind === 'candidate' && value.name === `${item.id}.json`)
        if (!entry?.version) throw new Error('活动候选缺少版本')
        return { id: item.id, version: entry.version, target: item.target, summary: item.summary }
      })
      const value = deliveryReviewSchema.parse({ formatVersion: 1, id: input.id, worldId: this.world.worldId, taskId: input.taskId, judgmentId: input.judgmentId,
        createdAt: input.createdAt, requestDigest, discoveryDigest: pageDiscovery(snapshot).version, discovery: snapshot, judgmentVersion: first.version,
        artifacts, deferred: active, reportIds: normalized.reportIds, uncovered, notes: normalized.notes })
      return this.save('reviews', value.id, value)
    })
  }
  /** 用户实际阅读的审阅版本；该记录本身不表示确认。 */
  readReview(id: string) {
    this.check(); return this.gate.run(async () => {
      if (this.closed) throw new Error('交付服务已关闭')
      const result = await this.read('reviews', id, deliveryReviewSchema)
      if (result.value.id !== id || result.value.worldId !== this.world.worldId) throw new Error('交付审阅身份不匹配')
      return result
    })
  }
  /** 按明确动作复核全部证据并独占保存交付；不能自动放弃或发布候选。 */
  complete(input: { id: string; taskId: string; reviewId: string; reviewVersion: string; createdAt: string; confirm: true;
    deferredCandidateIds: readonly string[]; acknowledgedUncovered: readonly string[] }) {
    this.check()
    return this.gate.run(async () => {
      if (this.closed) throw new Error('交付服务已关闭')
      if (input.confirm !== true) throw new Error('需要用户明确完成动作')
      uuid.parse(input.id)
      if (await this.fs.stat(await this.file('deliveries', input.id))) {
        const saved = await this.read('deliveries', input.id, deliverySchema)
        if (saved.value.id !== input.id || saved.value.worldId !== this.world.worldId || saved.value.taskId !== input.taskId || saved.value.reviewId !== input.reviewId ||
          saved.value.reviewVersion !== input.reviewVersion || saved.value.createdAt !== input.createdAt || !sameSet(saved.value.deferredCandidateIds, input.deferredCandidateIds) ||
          !sameSet(saved.value.acknowledgedUncovered, input.acknowledgedUncovered)) throw new Error('完成身份已用于不同请求')
        return saved
      }
      const review = await this.read('reviews', input.reviewId, deliveryReviewSchema); const value = review.value
      if (value.id !== input.reviewId || value.worldId !== this.world.worldId || value.taskId !== input.taskId || review.version !== input.reviewVersion) throw new Error('交付审阅身份或版本已变化')
      if (!sameSet(value.deferred.map(item => item.id), input.deferredCandidateIds)) throw new Error('必须逐项明确暂留全部活动候选')
      if (!sameSet(value.uncovered, input.acknowledgedUncovered)) throw new Error('必须逐项知悉全部未覆盖范围')
      const snapshot = await this.snapshot()
      if (pageDiscovery(snapshot).version !== value.discoveryDigest || hash(JSON.stringify(snapshot)) !== hash(JSON.stringify(value.discovery))) throw new Error('业务记录范围或版本已变化，请重新审阅')
      const candidates = await this.verifyConflicts(snapshot)
      const active = candidates.filter(item => item.status === 'active').map(item => {
        const entry = snapshot.entries.find(record => record.kind === 'candidate' && record.name === item.id + '.json')
        if (!entry?.version) throw new Error('活动候选缺少版本')
        return { id: item.id, version: entry.version, target: item.target, summary: item.summary }
      })
      if (JSON.stringify(active) !== JSON.stringify(value.deferred)) throw new Error('活动候选与审阅不一致')
      const uncovered = await this.checkedReports(snapshot, value.reportIds)
      if (!sameSet(uncovered, value.uncovered)) throw new Error('未覆盖范围与审阅不一致')
      const first = await this.tasks.readFirstVersion(value.taskId, value.judgmentId)
      if (first.version !== value.judgmentVersion || first.artifacts.some(item => item.status !== 'current')) throw new Error('第一版依据已变化')
      const targets = value.artifacts.map(item => JSON.stringify(parseDiscussionTarget(item.target)))
      if (!unique(targets) || first.value.artifacts.some(item => !targets.includes(JSON.stringify(parseDiscussionTarget(item.target))))) throw new Error('交付范围遗漏或重复第一版依据')
      for (const item of value.artifacts) {
        const target = parseDiscussionTarget(item.target)
        if (this.adapter.isTargetBoundToWorld?.(target, this.world) !== true) throw new Error('交付成果不属于此世界')
        const current = await this.adapter.read(target)
        if (current.version !== item.version || current.content !== item.content || hash(item.content) !== item.digest) throw new Error('交付正文已变化，请重新审阅')
      }
      const record = deliverySchema.parse({ formatVersion: 1, id: input.id, worldId: this.world.worldId, taskId: input.taskId, reviewId: input.reviewId,
        reviewVersion: input.reviewVersion, createdAt: input.createdAt, deferredCandidateIds: [...input.deferredCandidateIds],
        acknowledgedUncovered: [...input.acknowledgedUncovered], review: value })
      return this.save('deliveries', record.id, record)
    })
  }
  readDelivery(id: string) {
    this.check(); return this.gate.run(async () => {
      if (this.closed) throw new Error('交付服务已关闭')
      const result = await this.read('deliveries', id, deliverySchema)
      if (result.value.id !== id || result.value.worldId !== this.world.worldId) throw new Error('交付身份不匹配')
      return result
    })
  }
  close(): Promise<void> {
    if (this.closed) return Promise.resolve()
    if (!this.closing) this.closing = this.gate.run(async () => { this.closed = true; occupied.delete(this.rootKey) })
    return this.closing
  }
}
