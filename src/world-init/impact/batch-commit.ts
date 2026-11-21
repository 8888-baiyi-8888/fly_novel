import { createHash } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { parseDocument } from 'yaml'
import { z } from 'zod'
import { LocalFileSystem } from '@fly-novel/fs-local'
import type { FsVersion } from '@fly-novel/fs'
import type { WorldAccess } from '@fly-novel/util'
import { isPathUnder } from '@fly-novel/fs-sandbox'
import { validateWorldWorkspaceConfigs, type WorldWorkspaceConfig } from '../workspace/config.js'
import { parseDiscussionTarget, type DiscussionService } from '../discussion/service.js'
import type { ImpactService } from './service.js'
import type { ReviewService } from './review.js'
import type { TargetPublisher } from './target-publisher.js'

const uuid = z.string().uuid()
const digest = (content: string) => createHash('sha256').update(content).digest('hex')
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 4096)
const itemSchema = z.object({ candidateId: uuid, candidateVersion: z.string().min(1), reportId: uuid, reportVersion: z.string().min(1),
  target: z.unknown(), baseline: z.string().min(1), beforeDigest: z.string().length(64), afterDigest: z.string().length(64), afterVersion: z.string().nullable(),
  phase: z.enum(['ready', 'locking', 'publishing', 'published', 'committed', 'failed']),
  catalogStatus: z.enum(['pending', 'not-configured', 'unregistered', 'current', 'stale', 'failed']), catalogError: z.string().nullable(),
  recoveryDecision: z.object({ kind: z.enum(['accept-result', 'accept-baseline']), observedVersion: z.string().min(1), confirmedAt: z.iso.datetime() }).strict().nullable() }).strict()
const batchSchema = z.object({ formatVersion: z.literal(1), id: uuid, worldId: z.string().min(1), discussionId: uuid,
  reviewVersion: z.string().min(1), confirmationVersion: z.string().min(1), state: z.enum(['running', 'stopped', 'completed']),
  error: z.string().nullable(), items: z.array(itemSchema).min(1).max(100) }).strict()
type Batch = z.infer<typeof batchSchema>
type Item = z.infer<typeof itemSchema>
const occupied = new Set<string>()
function validateBatch(value: Batch): void {
  if (new Set(value.items.map(item => item.candidateId)).size !== value.items.length) throw new Error('批量记录候选重复')
  for (const item of value.items) {
    parseDiscussionTarget(item.target)
    if ((item.phase === 'published' || item.phase === 'committed') !== (item.afterVersion !== null)) throw new Error('批量记录发布版本与状态不一致')
    if (item.phase !== 'committed' && (item.catalogStatus !== 'pending' || item.catalogError !== null)) throw new Error('未发布目标不能有目录结果')
    if ((item.catalogStatus === 'failed') !== (item.catalogError !== null)) throw new Error('目录状态与错误不一致')
  }
  if (value.state === 'completed' && value.items.some(item => item.phase !== 'committed' || item.catalogStatus === 'pending' || item.catalogStatus === 'failed')) throw new Error('批量完成状态与目标结果不一致')
}

/** 多目标逐项发布；失败后停止，不自动回滚或继续。 */
export class BatchCommitService {
  private closed = false
  private closing?: Promise<void>
  private constructor(private readonly world: WorldWorkspaceConfig, private readonly root: string, private readonly fs: LocalFileSystem,
    private readonly gate: WorldAccess, private readonly discussion: DiscussionService, private readonly impact: ImpactService,
    private readonly review: ReviewService, private readonly publisher: TargetPublisher) {}

  static async open(options: { workspaces: readonly WorldWorkspaceConfig[]; worldId: string; root: string; fs: LocalFileSystem; gate: WorldAccess;
    discussion: DiscussionService; impact: ImpactService; review: ReviewService; publisher: TargetPublisher; sessionRoots: readonly string[]; singleWriterProcess: true }): Promise<BatchCommitService> {
    if (options.singleWriterProcess !== true) throw new Error('必须确保单可信写入进程')
    const worlds = await validateWorldWorkspaceConfigs(options.workspaces); const world = worlds.find(item => item.worldId === options.worldId)
    if (!world || !options.discussion.isBoundToWorld(world) || !options.impact.isBoundToWorld(world) || !options.review.isBoundToWorld(world) ||
      !options.review.isBoundTo(options.discussion, options.impact) || !options.publisher.isBoundTo(world)) throw new Error('批量发布身份不匹配')
    if (!(options.fs instanceof LocalFileSystem) || !options.discussion.hasCoordinatedBackend() || !options.impact.hasCoordinatedBackends() || !options.review.hasCoordinatedBackend()) throw new Error('批量发布只支持已协调的本机后端')
    if (!isAbsolute(options.root) || await realpath(options.root) !== resolve(options.root) || !(await lstat(options.root)).isDirectory()) throw new Error('批量记录根必须是真实目录')
    const businessRoots = [options.discussion.rootDirectory, options.impact.rootDirectory, options.review.rootDirectory, options.root]
    for (const path of [...worlds.map(item => item.readRoot), ...businessRoots.slice(0, -1)]) {
      if (await isPathUnder(options.root, path) || await isPathUnder(path, options.root)) throw new Error('批量记录根与其他资料根重叠')
    }
    if (!Array.isArray(options.sessionRoots)) throw new Error('必须提供全部 Session 根')
    for (const session of options.sessionRoots) {
      if (!isAbsolute(session) || await realpath(session) !== resolve(session) || !(await lstat(session)).isDirectory()) throw new Error('Session 根必须是真实目录')
      for (const path of businessRoots) if (await isPathUnder(session, path) || await isPathUnder(path, session)) throw new Error('业务记录根与 Session 根重叠')
    }
    for (const path of [world.readRoot, ...businessRoots]) if (!options.gate.covers(path)) throw new Error('协调范围未覆盖批量发布所需目录')
    const root = process.platform === 'win32' ? options.root.toLowerCase() : options.root
    if (occupied.has(root)) throw new Error('批量记录目录已打开')
    occupied.add(root)
    return new BatchCommitService(world, root, options.fs, options.gate, options.discussion, options.impact, options.review, options.publisher)
  }
  private async file(id: string) {
    uuid.parse(id); const path = join(this.root, `${id}.json`); const info = await this.fs.lstat(path)
    if (info && info.type !== 'file') throw new Error('批量记录必须是普通文件')
    const parent = await this.fs.resolve(this.root); const file = await this.fs.resolve(path)
    if (!this.fs.contains(parent, file)) throw new Error('批量记录路径越界')
    return file
  }
  private async read(id: string): Promise<{ value: Batch; version: FsVersion }> {
    const file = await this.file(id); const before = await this.fs.stat(file)
    if (!before || before.type !== 'file') throw new Error('批量记录不存在')
    const text = new TextDecoder('utf-8', { fatal: true }).decode(await this.fs.readBytes(file, undefined, 16 * 1024 * 1024))
    if (parseDocument(text, { uniqueKeys: true }).errors.length) throw new Error('批量记录格式无效')
    const value = batchSchema.parse(JSON.parse(text)); const after = await this.fs.stat(file)
    if (!after || after.version !== before.version || value.id !== id || value.worldId !== this.world.worldId) throw new Error('批量记录身份或版本不匹配')
    validateBatch(value)
    return { value, version: after.version }
  }
  private async save(value: Batch, version?: FsVersion): Promise<FsVersion> {
    const parsed = batchSchema.parse(value); validateBatch(parsed)
    const text = `${JSON.stringify(parsed, null, 2)}\n`
    if (Buffer.byteLength(text, 'utf8') > 16 * 1024 * 1024) throw new Error('批量记录超出大小限制')
    try { return (await this.fs.writeText(await this.file(value.id), text, version ? { kind: 'replaceIfVersion', version } : { kind: 'createIfAbsent' })).version }
    catch (error) { throw new Error(`批量记录写入失败或结果不确定，请核查 ${value.id}`, { cause: error }) }
  }

  /** 在全局协调下复核完整确认，按用户选择顺序逐项发布。 */
  submit(discussionId: string, reviewId: string, confirmationVersion: string, signal?: AbortSignal): Promise<Batch> {
    if (this.closed) return Promise.reject(new Error('批量发布服务已关闭'))
    return this.gate.run(async () => {
      signal?.throwIfAborted()
      if (await this.fs.stat(await this.file(reviewId))) throw new Error('该确认已有发布记录，请先核查')
      const confirmation = await this.review.readConfirmation(discussionId, reviewId)
      if (confirmation.version !== confirmationVersion) throw new Error('确认版本已变化')
      const review = await this.review.read(discussionId, reviewId)
      if (review.version !== confirmation.value.reviewVersion) throw new Error('审阅版本已变化')
      for (const report of review.value.reports) {
        const check = await this.impact.verify(discussionId, report.report.id, report.version)
        if (check.status !== 'current') throw new Error(`检查报告需要重新检查：${check.reason}`)
      }
      const items: Item[] = []
      for (const candidateId of confirmation.value.selectedCandidateIds) {
        const binding = review.value.reports.find(item => item.report.candidateId === candidateId)
        if (!binding) throw new Error('确认候选不属于审阅')
        const candidate = await this.discussion.validateForPublish(discussionId, candidateId, binding.report.candidateVersion)
        if (!this.discussion.isTargetBoundToWorld(candidate.value.target, this.world)) throw new Error('候选目标未绑定当前世界')
        if (candidate.current.version !== binding.report.currentVersion || candidate.current.content !== binding.report.currentContent) throw new Error('当前正文与审阅不一致')
        const after = await this.publisher.preview(candidate.value.target, candidate.value.content)
        const beforeDigest = digest(candidate.current.content); const afterDigest = digest(after)
        if (beforeDigest === afterDigest) throw new Error('候选没有可发布的正文变化')
        items.push({ candidateId, candidateVersion: candidate.version, reportId: binding.report.id, reportVersion: binding.version,
          target: candidate.value.target, baseline: candidate.value.baseline, beforeDigest, afterDigest, afterVersion: null, phase: 'ready', catalogStatus: 'pending', catalogError: null, recoveryDecision: null })
      }
      const value = batchSchema.parse({ formatVersion: 1, id: reviewId, worldId: this.world.worldId, discussionId, reviewVersion: review.version,
        confirmationVersion, state: 'running', error: null, items })
      signal?.throwIfAborted(); let version = await this.save(value)
      for (const item of value.items) {
        try {
          signal?.throwIfAborted()
          const candidate = await this.discussion.validateForPublish(discussionId, item.candidateId, item.candidateVersion)
          if (candidate.current.version !== item.baseline || digest(candidate.current.content) !== item.beforeDigest) throw new Error('当前资料在发布前变化')
          item.phase = 'locking'; version = await this.save(value, version)
          const locked = await this.discussion.markPublishing(discussionId, item.candidateId, item.candidateVersion, value.id)
          item.phase = 'publishing'; version = await this.save(value, version)
          await this.publisher.publish(parseDiscussionTarget(item.target), candidate.value.content, item.baseline, signal)
          const actual = await this.discussion.readRelated(discussionId, parseDiscussionTarget(item.target))
          if (digest(actual.content) !== item.afterDigest) throw new Error('发布正文与预期不一致')
          item.phase = 'published'; item.afterVersion = actual.version; version = await this.save(value, version)
          await this.discussion.markCommitted(discussionId, item.candidateId, locked.version, value.id)
          item.phase = 'committed'; version = await this.save(value, version)
          try { item.catalogStatus = await this.publisher.catalogStatus(parseDiscussionTarget(item.target)); version = await this.save(value, version) }
          catch (error) { item.catalogStatus = 'failed'; item.catalogError = errorText(error); throw error }
        } catch (error) {
          value.state = 'stopped'; value.error = errorText(error)
          try { await this.save(value, version) } catch (recordError) { throw new AggregateError([error, recordError], `批量发布结果需要核查：${value.id}`) }
          return value
        }
      }
      value.state = 'completed'; await this.save(value, version); return value
    })
  }

  /** 按实际记录查看各目标状态；完成项不代表整组完成。 */
  inspect(id: string) { if (this.closed) return Promise.reject(new Error('批量发布服务已关闭')); return this.gate.run(() => this.read(id)) }

  /** 标记中断后的批量操作已停止，后续目标必须重新检查并取得新的用户确认。 */
  stopAfterInterrupt(id: string): Promise<Batch> {
    if (this.closed) return Promise.reject(new Error('批量发布服务已关闭'))
    return this.gate.run(async () => { const record = await this.read(id); if (record.value.state === 'running') { record.value.state = 'stopped'; record.value.error = '进程中断，后续目标需要重新检查'; await this.save(record.value, record.version) } return record.value })
  }

  /** 核查单项中断；未经新审阅不会继续后续目标。 */
  reconcileItem(id: string, candidateId: string, decision?: { kind: 'accept-result' | 'accept-baseline'; observedVersion: string }): Promise<Batch> {
    if (this.closed) return Promise.reject(new Error('批量发布服务已关闭'))
    return this.gate.run(async () => {
      const record = await this.read(id); const value = record.value; let version = record.version
      const item = value.items.find(entry => entry.candidateId === candidateId)
      if (!item) throw new Error('发布记录不包含该候选')
      if (value.state === 'running') { value.state = 'stopped'; value.error = '进程中断，后续目标需要重新检查'; version = await this.save(value, version) }
      if (item.phase === 'ready' || item.phase === 'failed' || item.phase === 'committed') return value
      const target = parseDiscussionTarget(item.target)
      let actual: { content: string; version: string }
      try { actual = await this.discussion.readRelated(value.discussionId, target) }
      catch (error) {
        if (target.kind !== 'character') throw error
        await this.publisher.recoverCharacter(target, item.baseline, item.afterDigest)
        actual = await this.discussion.readRelated(value.discussionId, target)
      }
      const before = actual.version === item.baseline && digest(actual.content) === item.beforeDigest
      const after = digest(actual.content) === item.afterDigest
      if (item.phase === 'locking' && !before) throw new Error('发布前正文已变化，禁止自动恢复')
      if (item.phase === 'published' && (!after || actual.version !== item.afterVersion)) throw new Error('发布后的正文已变化，禁止自动恢复')
      if (item.phase === 'publishing') {
        if (!before && !after) throw new Error('发布结果不确定，正文已变化')
        const kind = after ? 'accept-result' : 'accept-baseline'
        if (item.recoveryDecision?.kind !== kind || item.recoveryDecision.observedVersion !== actual.version) {
          if (decision?.kind !== kind || decision.observedVersion !== actual.version) throw new Error('发布结果不确定，需用户核查当前版本后明确选择')
          item.recoveryDecision = { kind, observedVersion: actual.version, confirmedAt: new Date().toISOString() }
          version = await this.save(value, version)
        }
      }
      const candidate = await this.discussion.readCandidate(candidateId)
      if (candidate.value.discussionId !== value.discussionId) throw new Error('候选讨论身份不匹配')
      if (before) {
        if (candidate.value.status === 'publishing' && candidate.value.operationId === id) await this.discussion.restoreActive(value.discussionId, candidateId, candidate.version, id)
        else if (candidate.value.status !== 'active' || candidate.version !== item.candidateVersion) throw new Error('候选已变化，禁止自动恢复')
        item.phase = 'failed'
      } else {
        if (candidate.value.status === 'publishing' && candidate.value.operationId === id) await this.discussion.markCommitted(value.discussionId, candidateId, candidate.version, id)
        else if (candidate.value.status !== 'committed' || candidate.value.operationId !== id) throw new Error('候选已变化，禁止自动恢复')
        item.phase = 'committed'; item.afterVersion = actual.version
      }
      if (item.phase === 'committed') {
        try { item.catalogStatus = await this.publisher.catalogStatus(target); item.catalogError = null }
        catch (error) { item.catalogStatus = 'failed'; item.catalogError = errorText(error) }
      }
      await this.save(value, version); return value
    })
  }

  /** 单独复核目录状态；不覆盖简介，不改变已发布正文。 */
  recheckCatalog(id: string, candidateId: string): Promise<Batch> {
    if (this.closed) return Promise.reject(new Error('批量发布服务已关闭'))
    return this.gate.run(async () => {
      const record = await this.read(id); const item = record.value.items.find(entry => entry.candidateId === candidateId)
      if (!item || item.phase !== 'committed') throw new Error('只能复核已发布目标的目录状态')
      try { item.catalogStatus = await this.publisher.catalogStatus(parseDiscussionTarget(item.target)); item.catalogError = null }
      catch (error) { item.catalogStatus = 'failed'; item.catalogError = errorText(error); record.value.state = 'stopped'; record.value.error = item.catalogError }
      await this.save(record.value, record.version); return record.value
    })
  }

  close(): Promise<void> { if (!this.closing) { this.closed = true; this.closing = this.gate.run(async () => { occupied.delete(this.root) }) } return this.closing }
}
