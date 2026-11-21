import { createHash } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { parseDocument } from 'yaml'
import { z } from 'zod'
import type { FileSystem, FsVersion } from '@fly-novel/fs'
import { LocalFileSystem } from '@fly-novel/fs-local'
import { parseMapPlace, formatMapDocument, type MapStore } from '@fly-novel/map'
import { parseCharacterDocument, formatCharacterDocument, type CharacterStore } from '@fly-novel/character'
import { type WorldAccess } from '@fly-novel/util'
import { isPathUnder } from '@fly-novel/fs-sandbox'
import { validateWorldWorkspaceConfigs, type WorldWorkspaceConfig } from '../workspace/config.js'
import type { DiscussionService } from '../discussion/service.js'
import type { ImpactService } from './service.js'
import type { ReviewService } from './review.js'

const uuid = z.string().uuid()
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const target = z.discriminatedUnion('kind', [z.object({ kind: z.literal('place'), id: uuid }).strict(), z.object({ kind: z.literal('character'), id: uuid }).strict()])
export const operationSchema = z.object({ formatVersion: z.literal(1), id: uuid, worldId: z.string().min(1), discussionId: uuid,
  reviewVersion: z.string().min(1), confirmationVersion: z.string().min(1), reportId: uuid, reportVersion: z.string().min(1),
  candidateId: uuid, candidateVersion: z.string().min(1), baseline: z.string().min(1), target,
  beforeDigest: z.string().length(64), afterDigest: z.string().length(64), afterVersion: z.string().nullable(),
  recoveryDecision: z.object({ kind: z.enum(['accept-result', 'accept-baseline']), observedVersion: z.string().min(1), confirmedAt: z.iso.datetime() }).strict().nullable(),
  phase: z.enum(['prepared', 'publishing', 'published', 'committed', 'failed']) }).strict()
type Operation = z.infer<typeof operationSchema>
const occupied = new Set<string>()

/** 可信应用持有的首批单目标发布服务，模型工具不得持有此服务。 */
export class WorldCommitService {
  private closed = false
  private closing?: Promise<void>
  private constructor(private readonly world: WorldWorkspaceConfig, private readonly root: string, private readonly fs: FileSystem,
    private readonly gate: WorldAccess, private readonly discussion: DiscussionService, private readonly impact: ImpactService,
    private readonly review: ReviewService, private readonly map?: MapStore, private readonly characters?: CharacterStore) {}

  /** 根目录须预先创建并由相同世界协调器覆盖；借用的句柄由调用方关闭。 */
  static async open(options: { workspaces: readonly WorldWorkspaceConfig[]; worldId: string; root: string; fs: FileSystem; gate: WorldAccess;
    discussion: DiscussionService; impact: ImpactService; review: ReviewService; sessionRoots: readonly string[]; map?: MapStore; characters?: CharacterStore; singleWriterProcess: true }): Promise<WorldCommitService> {
    if (options.singleWriterProcess !== true) throw new Error('必须确保单可信写入进程')
    const worlds = await validateWorldWorkspaceConfigs(options.workspaces); const world = worlds.find(item => item.worldId === options.worldId)
    if (!world || !options.discussion.isBoundToWorld(world) || !options.impact.isBoundToWorld(world) ||
      !options.review.isBoundToWorld(world) || !options.review.isBoundTo(options.discussion, options.impact)) throw new Error('发布服务身份不匹配')
    if (!(options.fs instanceof LocalFileSystem) || !options.discussion.hasCoordinatedBackend() || !options.review.hasCoordinatedBackend() ||
      !options.impact.hasCoordinatedBackends() || (options.map && !(options.map.fileSystem instanceof LocalFileSystem))) throw new Error('发布只支持已接入世界协调的本机文件后端')
    if (!isAbsolute(options.root) || await realpath(options.root) !== resolve(options.root) || !(await lstat(options.root)).isDirectory()) throw new Error('发布记录根必须是现有真实目录')
    for (const path of [...worlds.map(item => item.readRoot), options.discussion.rootDirectory, options.impact.rootDirectory, options.review.rootDirectory]) {
      if (await isPathUnder(options.root, path) || await isPathUnder(path, options.root)) throw new Error('发布记录根与其他资料根重叠')
    }
    if (!Array.isArray(options.sessionRoots)) throw new Error('必须提供全部 Session 根')
    for (const session of options.sessionRoots) {
      if (!isAbsolute(session) || await realpath(session) !== resolve(session) || !(await lstat(session)).isDirectory()) throw new Error('Session 根必须是现有真实目录')
      for (const path of [options.root, options.discussion.rootDirectory, options.impact.rootDirectory, options.review.rootDirectory]) {
        if (await isPathUnder(session, path) || await isPathUnder(path, session)) throw new Error('业务记录根不能与 Session 根重叠')
      }
    }
    for (const path of [world.readRoot, options.discussion.rootDirectory, options.impact.rootDirectory, options.review.rootDirectory, options.root]) {
      if (!options.gate.covers(path)) throw new Error('协调范围未覆盖发布所需目录')
    }
    if (options.map && (options.map.boundWorldId !== world.worldId || !world.agents.some(item => item.writableRoot === options.map!.rootDirectory))) throw new Error('地图存储身份不匹配')
    if (options.characters && !world.agents.some(item => item.writableRoot === options.characters!.rootDirectory)) throw new Error('人物存储身份不匹配')
    const key = process.platform === 'win32' ? options.root.toLowerCase() : options.root
    if (occupied.has(key)) throw new Error('发布记录目录已打开')
    occupied.add(key)
    return new WorldCommitService(world, key, options.fs, options.gate, options.discussion, options.impact, options.review, options.map, options.characters)
  }

  private async file(id: string) {
    uuid.parse(id); const path = join(this.root, `${id}.json`); const info = await this.fs.lstat(path)
    if (info && info.type !== 'file') throw new Error('发布记录必须是普通文件')
    const parent = await this.fs.resolve(this.root); const result = await this.fs.resolve(path)
    if (!this.fs.contains(parent, result)) throw new Error('发布记录路径越界')
    return result
  }
  private async read(id: string): Promise<{ value: Operation; version: FsVersion }> {
    const path = await this.file(id); const before = await this.fs.stat(path)
    if (!before || before.type !== 'file') throw new Error('发布记录不存在')
    const text = new TextDecoder('utf-8', { fatal: true }).decode(await this.fs.readBytes(path, undefined, 1024 * 1024))
    if (parseDocument(text, { uniqueKeys: true }).errors.length) throw new Error('发布记录格式无效')
    const value = operationSchema.parse(JSON.parse(text)); const after = await this.fs.stat(path)
    if (!after || after.version !== before.version || value.id !== id || value.worldId !== this.world.worldId) throw new Error('发布记录身份或版本不匹配')
    return { value, version: after.version }
  }
  private async save(value: Operation, version?: FsVersion): Promise<FsVersion> {
    const text = `${JSON.stringify(operationSchema.parse(value), null, 2)}\n`
    try { return (await this.fs.writeText(await this.file(value.id), text, version ? { kind: 'replaceIfVersion', version } : { kind: 'createIfAbsent' })).version }
    catch (error) { throw new Error(`发布记录写入失败或结果不确定，请核查 ${value.id}`, { cause: error }) }
  }
  private async actual(value: Operation): Promise<{ content: string; version: string }> {
    if (value.target.kind === 'place') {
      if (!this.map) throw new Error('地图发布未装配')
      const result = await this.map.readPlace(value.target.id)
      return { content: formatMapDocument(result.document), version: result.version }
    }
    if (!this.characters) throw new Error('人物发布未装配')
    const result = await this.characters.readVersioned(value.target.id)
    return { content: formatCharacterDocument(result.document), version: result.version }
  }

  /** 接收可信应用保存的确认版本；当前仅允许一个已审阅地点或人物。 */
  submit(discussionId: string, reviewId: string, confirmationVersion: string, signal?: AbortSignal): Promise<Operation> {
    if (this.closed) return Promise.reject(new Error('发布服务已关闭'))
    return this.gate.run(async () => {
      signal?.throwIfAborted()
      const confirmation = await this.review.readConfirmation(discussionId, reviewId)
      if (confirmation.version !== confirmationVersion || confirmation.value.selectedCandidateIds.length !== 1) throw new Error('确认版本不匹配或暂不支持多目标发布')
      const review = await this.review.read(discussionId, reviewId)
      if (review.version !== confirmation.value.reviewVersion) throw new Error('审阅版本已变化')
      const selected = confirmation.value.selectedCandidateIds[0]!
      const binding = review.value.reports.find(item => item.report.candidateId === selected)
      if (!binding) throw new Error('确认候选不属于审阅')
      for (const item of review.value.reports) {
        const current = await this.impact.verify(discussionId, item.report.id, item.version)
        if (current.status !== 'current') throw new Error(`检查报告需要重新检查：${current.reason}`)
      }
      const candidate = await this.discussion.readCandidate(selected)
      if (candidate.value.status !== 'active' || candidate.value.discussionId !== discussionId || candidate.stale || candidate.version !== binding.report.candidateVersion) throw new Error('候选状态或版本已变化')
      await this.discussion.validateForPublish(discussionId, selected, candidate.version)
      const selectedTarget = target.parse(candidate.value.target)
      if (!this.discussion.isTargetBoundToWorld(selectedTarget, this.world)) throw new Error('候选目标未绑定当前世界')
      let after: string
      if (selectedTarget.kind === 'place') {
        if (!this.map) throw new Error('地图发布未装配')
        const proposed = parseMapPlace(candidate.value.content)
        if (proposed.id !== selectedTarget.id || proposed.worldId !== this.world.worldId) throw new Error('地点候选身份不匹配')
        after = formatMapDocument(proposed)
      } else {
        if (!this.characters) throw new Error('人物发布未装配')
        const current = await this.characters.readVersioned(selectedTarget.id)
        const proposed = parseCharacterDocument(candidate.value.content)
        if (proposed.metadata.id !== selectedTarget.id || proposed.metadata.contentStatus !== 'pending') throw new Error('人物候选身份或状态不匹配')
        after = formatCharacterDocument({ ...proposed, metadata: { ...proposed.metadata, contentStatus: current.document.metadata.contentStatus } })
      }
      const beforeDigest = hash(binding.report.currentContent); const afterDigest = hash(after)
      if (beforeDigest === afterDigest) throw new Error('候选没有可发布的正文变化')
      const value = operationSchema.parse({ formatVersion: 1, id: reviewId, worldId: this.world.worldId, discussionId, reviewVersion: review.version,
        confirmationVersion, reportId: binding.report.id, reportVersion: binding.version, candidateId: selected, candidateVersion: candidate.version,
        baseline: candidate.value.baseline, target: selectedTarget, beforeDigest, afterDigest, afterVersion: null, recoveryDecision: null, phase: 'prepared' })
      const actualBefore = await this.actual(value)
      if (actualBefore.version !== value.baseline || hash(actualBefore.content) !== value.beforeDigest) throw new Error('发布目标与审阅正文或基线不一致')
      signal?.throwIfAborted()
      let version = await this.save(value)
      signal?.throwIfAborted()
      const locked = await this.discussion.markPublishing(discussionId, selected, candidate.version, value.id)
      value.phase = 'publishing'; version = await this.save(value, version)
      try {
        if (selectedTarget.kind === 'place') {
          const existing = await this.map!.readPlace(selectedTarget.id)
          if (existing.version !== value.baseline) throw new Error('地点基线已变化')
          await this.map!.publishPlaceCandidate(parseMapPlace(candidate.value.content), existing.version, signal)
        } else {
          const proposed = parseCharacterDocument(candidate.value.content)
          const { formatVersion: _format, id: _id, contentStatus: _status, ...fields } = proposed.metadata
          await this.characters!.publishReviewed(selectedTarget.id, value.baseline, { ...fields, body: proposed.body }, signal)
        }
        const actual = await this.actual(value)
        if (hash(actual.content) !== value.afterDigest) throw new Error('发布正文与预期不一致')
        value.phase = 'published'; value.afterVersion = actual.version; version = await this.save(value, version)
        await this.discussion.markCommitted(discussionId, selected, locked.version, value.id)
        value.phase = 'committed'; await this.save(value, version)
        return value
      } catch (error) { throw new Error(`发布结果需要核查：${value.id}`, { cause: error }) }
    })
  }

  /** 供可信恢复装配核对同一世界、协调器及讨论服务。 */
  isBoundToRecovery(world: WorldWorkspaceConfig, gate: WorldAccess, discussion: DiscussionService): boolean {
    return this.world.worldId === world.worldId && this.discussion === discussion && this.gate === gate && this.discussion.isBoundToWorld(world)
  }
  /** 读取发布记录，不从记录状态单独推断当前正文。 */
  inspect(id: string) { if (this.closed) return Promise.reject(new Error('发布服务已关闭')); return this.gate.run(() => this.read(id)) }

  /** 按实际正文和候选核查中断；结果无法区分时保留记录并拒绝自动推进。 */
  reconcile(id: string, decision?: { kind: 'accept-result' | 'accept-baseline'; observedVersion: string }): Promise<Operation> {
    if (this.closed) return Promise.reject(new Error('发布服务已关闭'))
    return this.gate.run(async () => {
      const record = await this.read(id); const value = record.value; let recordVersion = record.version
      if (value.phase === 'committed' || value.phase === 'failed') return value
      let actual: { content: string; version: string }
      try { actual = await this.actual(value) }
      catch (error) {
        if (value.target.kind !== 'character' || !this.characters) throw error
        await this.characters.recoverInitialization(value.target.id, { baseline: value.baseline, candidate: value.afterDigest })
        actual = await this.actual(value)
      }
      if (actual.version === value.baseline && hash(actual.content) === value.beforeDigest && value.phase !== 'published') {
        if (value.phase === 'publishing' && (value.recoveryDecision?.kind !== 'accept-baseline' || value.recoveryDecision.observedVersion !== actual.version)) {
          if (decision?.kind !== 'accept-baseline' || decision.observedVersion !== actual.version) throw new Error('发布结果不确定，需用户核查当前版本后明确选择')
          value.recoveryDecision = { kind: 'accept-baseline', observedVersion: actual.version, confirmedAt: new Date().toISOString() }
          recordVersion = await this.save(value, recordVersion)
        }
        const candidate = await this.discussion.readCandidate(value.candidateId)
        if (candidate.value.status === 'publishing' && candidate.value.operationId === value.id) await this.discussion.restoreActive(value.discussionId, value.candidateId, candidate.version, value.id)
        else if (candidate.value.status !== 'active') throw new Error('候选状态已变化，禁止自动恢复')
        value.phase = 'failed'; await this.save(value, recordVersion); return value
      }
      if (value.phase === 'prepared' || hash(actual.content) !== value.afterDigest) throw new Error('发布结果不确定，正文已变化，禁止自动恢复')
      if (value.phase === 'publishing' && (value.recoveryDecision?.kind !== 'accept-result' || value.recoveryDecision.observedVersion !== actual.version)) {
        if (decision?.kind !== 'accept-result' || decision.observedVersion !== actual.version) throw new Error('发布结果不确定，需用户核查当前版本后明确选择')
        value.recoveryDecision = { kind: 'accept-result', observedVersion: actual.version, confirmedAt: new Date().toISOString() }
        recordVersion = await this.save(value, recordVersion)
      }
      if (value.phase === 'published' && value.afterVersion !== actual.version) throw new Error('发布后的正文版本已变化，禁止自动恢复')
      const candidate = await this.discussion.readCandidate(value.candidateId)
      if (candidate.value.discussionId !== value.discussionId) throw new Error('候选讨论身份不匹配')
      if (candidate.value.status === 'publishing' && candidate.value.operationId === value.id) {
        await this.discussion.markCommitted(value.discussionId, value.candidateId, candidate.version, value.id)
      } else if (candidate.value.status !== 'committed' || candidate.value.operationId !== value.id) throw new Error('候选已变化，禁止自动恢复')
      value.phase = 'committed'; value.afterVersion = actual.version; await this.save(value, recordVersion); return value
    })
  }

  /** 关闭服务并等待协调器中的既有操作；底层句柄由持有者关闭。 */
  close(): Promise<void> {
    if (!this.closing) { this.closed = true; this.closing = this.gate.run(async () => { occupied.delete(this.root) }) }
    return this.closing
  }
}
