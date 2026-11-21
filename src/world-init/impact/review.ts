import { createHash, randomUUID } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { parseDocument } from 'yaml'
import { z } from 'zod'
import type { FileSystem } from '@fly-novel/fs'
import { LocalFileSystem } from '@fly-novel/fs-local'
import { CoordinatedOperations } from '@fly-novel/util'
import { isPathUnder } from '@fly-novel/fs-sandbox'
import { sameWorldWorkspace, validateWorldWorkspaceConfigs, type WorldWorkspaceConfig } from '../workspace/config.js'
import type { DiscussionService } from '../discussion/service.js'
import { impactReportSchema, type ImpactService } from './service.js'

const uuid = z.string().uuid()
const evidenceSchema = z.object({ reportId: uuid, scope: z.string().trim().min(1), sourceId: z.string().trim().min(1) }).strict()
const optionInputSchema = z.object({ label: z.string().trim().min(1), effect: z.string().trim().min(1), candidateIds: z.array(uuid), resolves: z.boolean() }).strict()
const findingInputSchema = z.object({ description: z.string().trim().min(1), severity: z.enum(['important', 'normal']), evidence: z.array(evidenceSchema).min(1),
  options: z.array(optionInputSchema).min(1), recommendedIndex: z.number().int().nonnegative().nullable() }).strict()
const optionSchema = optionInputSchema.extend({ id: uuid }).strict()
const findingSchema = z.object({ id: uuid, description: z.string().min(1), severity: z.enum(['important', 'normal']), evidence: z.array(evidenceSchema).min(1),
  options: z.array(optionSchema).min(1), recommendedOptionId: uuid.nullable() }).strict()
const dependencySchema = z.object({ candidateIds: z.array(uuid).min(2), reason: z.string().trim().min(1) }).strict()
const reportBindingSchema = z.object({ version: z.string().min(1), report: impactReportSchema }).strict()
const reviewSchema = z.object({ formatVersion: z.literal(1), worldId: z.string().min(1), discussionId: uuid, id: uuid, createdAt: z.iso.datetime(),
  reports: z.array(reportBindingSchema).min(1), findings: z.array(findingSchema), dependencies: z.array(dependencySchema) }).strict()
const uncoveredSchema = z.object({ reportId: uuid, scope: z.string().trim().min(1) }).strict()
const selectionSchema = z.object({ findingId: uuid, optionId: uuid }).strict()
const confirmationSchema = z.object({ formatVersion: z.literal(1), worldId: z.string().min(1), discussionId: uuid, reviewId: uuid,
  reviewVersion: z.string().min(1), createdAt: z.iso.datetime(), selectedCandidateIds: z.array(uuid).min(1), acknowledgedUncovered: z.array(uncoveredSchema),
  choices: z.array(selectionSchema.extend({ origin: z.enum(['explicit', 'recommended']) }).strict()) }).strict()
export type ReviewFindingInput = z.input<typeof findingInputSchema>
export type ReviewDependency = z.input<typeof dependencySchema>
export type ReviewDocument = z.infer<typeof reviewSchema>
export type ReviewConfirmation = z.infer<typeof confirmationSchema>
const occupiedWorlds = new Set<string>(); const occupiedRoots = new Set<string>()
const digest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')
const unique = (values: readonly string[]) => new Set(values).size === values.length
const scopeKey = (value: { reportId: string; scope: string }) => JSON.stringify([value.reportId, value.scope])

function validateReview(value: ReviewDocument): void {
  const reports = value.reports
  const candidateIds = new Set(reports.map(item => item.report.candidateId))
  if (!unique(reports.map(item => item.report.id)) || candidateIds.size !== reports.length ||
    reports.some(item => item.report.worldId !== value.worldId || item.report.discussionId !== value.discussionId)) throw new Error('审阅报告身份或候选重复')
  if (!unique(value.findings.map(item => item.id))) throw new Error('审阅检查项重复')
  for (const finding of value.findings) {
    if (!unique(finding.options.map(item => item.id)) || (finding.recommendedOptionId !== null && !finding.options.some(item => item.id === finding.recommendedOptionId))) throw new Error('审阅建议无效')
    for (const evidence of finding.evidence) {
      const report = reports.find(item => item.report.id === evidence.reportId)?.report
      if (!report?.scopes.find(scope => scope.name === evidence.scope)?.sources.some(source => source.id === evidence.sourceId)) throw new Error('检查发现缺少可核对的来源')
    }
    for (const option of finding.options) {
      if (!unique(option.candidateIds) || option.candidateIds.some(id => !candidateIds.has(id))) throw new Error('建议引用了未审阅的候选')
      if (finding.severity === 'important' && option.resolves && option.candidateIds.length === 0) throw new Error('重要冲突的处理缺少具体候选')
    }
  }
  for (const dependency of value.dependencies) if (!unique(dependency.candidateIds) || dependency.candidateIds.some(id => !candidateIds.has(id))) throw new Error('依赖引用了未审阅或重复的候选')
}

/** 仅供可信应用调用；用户确认不得由模型工具直接调用。 */
export class ReviewService {
  private readonly operations = new CoordinatedOperations()
  private tail: Promise<void> = Promise.resolve()
  private closed = false
  private closing?: Promise<void>
  private constructor(private readonly world: WorldWorkspaceConfig, private readonly root: string, private readonly fs: FileSystem,
    private readonly discussion: DiscussionService, private readonly impact: ImpactService) {}

  get boundWorldId(): string { return this.world.worldId }
  get rootDirectory(): string { return this.root }
  /** 供可信发布装配核验审阅文件后端。 */
  hasCoordinatedBackend(): boolean { return this.fs instanceof LocalFileSystem }
  /** 可信装配用于核对审阅、检查和讨论来自同一服务组。 */
  isBoundTo(discussion: DiscussionService, impact: ImpactService): boolean { return this.discussion === discussion && this.impact === impact }
  isBoundToWorld(world: WorldWorkspaceConfig): boolean { return sameWorldWorkspace(this.world, world) }

  /**
   * 打开独立审阅目录及其 `reviews`、`confirmations` 子目录。
   * @param options 可信世界、已绑定的讨论 / 检查服务、文件后端及单写入进程声明。
   * @returns 应用持有的审阅服务；使用后必须等待 close。
   * @throws 目录、世界或服务绑定无效，或同世界已打开时拒绝。
   */
  static async open(options: { workspaces: readonly WorldWorkspaceConfig[]; worldId: string; root: string; fs: FileSystem;
    discussion: DiscussionService; impact: ImpactService; singleWriterProcess: true }): Promise<ReviewService> {
    if (options.singleWriterProcess !== true) throw new Error('必须确保单可信写入进程')
    const worlds = await validateWorldWorkspaceConfigs(options.workspaces); const world = worlds.find(item => item.worldId === options.worldId)
    if (!world || options.discussion.boundWorldId !== world.worldId || !options.impact.isBoundToWorld(world) || !options.impact.isBoundTo(options.discussion)) throw new Error('审阅世界或服务绑定不匹配')
    if (!isAbsolute(options.root) || await realpath(options.root) !== resolve(options.root) || !(await lstat(options.root)).isDirectory()) throw new Error('审阅根必须是现有真实绝对目录')
    for (const root of [...worlds.map(item => item.readRoot), options.discussion.rootDirectory, options.impact.rootDirectory]) {
      if (await isPathUnder(options.root, root) || await isPathUnder(root, options.root)) throw new Error('审阅根与已有资料根重叠')
    }
    for (const name of ['reviews', 'confirmations']) {
      const path = join(options.root, name); const info = await lstat(path)
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) throw new Error('审阅子目录必须是现有真实目录')
    }
    const root = process.platform === 'win32' ? options.root.toLowerCase() : options.root
    if (occupiedWorlds.has(world.worldId) || occupiedRoots.has(root)) throw new Error('审阅服务已打开')
    occupiedWorlds.add(world.worldId); occupiedRoots.add(root)
    return new ReviewService(world, root, options.fs, options.discussion, options.impact)
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('审阅服务已关闭'))
    return this.operations.run([this.root], () => { const result = this.tail.then(fn); this.tail = result.then(() => undefined, () => undefined); return result })
  }
  private async target(folder: 'reviews' | 'confirmations', id: string) {
    uuid.parse(id); const path = join(this.root, folder, `${id}.json`); const info = await this.fs.lstat(path)
    if (info && info.type !== 'file') throw new Error('审阅记录必须是普通文件')
    const target = await this.fs.resolve(path); const parent = await this.fs.resolve(join(this.root, folder))
    if (!this.fs.contains(parent, target)) throw new Error('审阅记录路径越界')
    return target
  }
  private async load<T>(folder: 'reviews' | 'confirmations', id: string, schema: z.ZodType<T>): Promise<{ value: T; version: string }> {
    const target = await this.target(folder, id); const before = await this.fs.stat(target)
    if (!before || before.type !== 'file') throw new Error('审阅记录不存在')
    const bytes = await this.fs.readBytes(target, undefined, 16 * 1024 * 1024); const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (parseDocument(text, { uniqueKeys: true }).errors.length) throw new Error('审阅记录格式无效')
    const value = schema.parse(JSON.parse(text)); const after = await this.fs.stat(target)
    if (!after || before.version !== after.version) throw new Error('审阅记录读取期间发生变化')
    return { value, version: digest(bytes) }
  }
  private async publish(folder: 'reviews' | 'confirmations', id: string, value: unknown): Promise<string> {
    const text = `${JSON.stringify(value, null, 2)}\n`
    if (Buffer.byteLength(text, 'utf8') > 16 * 1024 * 1024) throw new Error('审阅记录超出大小限制')
    try { await this.fs.writeText(await this.target(folder, id), text, { kind: 'createIfAbsent' }) }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'FS_NOT_OBSERVED') throw new Error('审阅记录已存在，请先核查', { cause: error })
      throw new Error(`审阅记录发布结果不确定：${folder}/${id}.json`, { cause: error })
    }
    return digest(text)
  }

  /**
   * 创建可展示的审阅快照；建议由调用方提供，证据及候选引用必须属于已读取报告。
   * @param discussionId 可信讨论 ID。
   * @param reportIds 本次审阅的影响报告 ID。
   * @param input 待展示发现、候选选项和已知目标依赖。
   * @returns 已保存的审阅全文及其版本；不产生用户确认。
   */
  create(discussionId: string, reportIds: readonly string[], input: { findings: readonly ReviewFindingInput[]; dependencies: readonly ReviewDependency[] }) { return this.enqueue(async () => {
    await this.discussion.readDiscussion(discussionId)
    if (!reportIds.length || !unique(reportIds)) throw new Error('必须提供不重复的检查报告')
    const reports = await Promise.all(reportIds.map(id => this.impact.read(discussionId, id)))
    if (!unique(reports.map(item => item.report.candidateId))) throw new Error('候选检查报告重复')
    const candidateIds = new Set(reports.map(item => item.report.candidateId))
    const drafts = z.array(findingInputSchema).parse(input.findings)
    const findings = drafts.map(item => {
      if (item.recommendedIndex !== null && item.recommendedIndex >= item.options.length) throw new Error('推荐选项不存在')
      for (const evidence of item.evidence) {
        const report = reports.find(value => value.report.id === evidence.reportId)?.report
        const scope = report?.scopes.find(value => value.name === evidence.scope)
        if (!scope || !scope.sources.some(value => value.id === evidence.sourceId)) throw new Error('检查发现缺少可核对的来源')
      }
      for (const option of item.options) {
        if (!unique(option.candidateIds) || option.candidateIds.some(id => !candidateIds.has(id))) throw new Error('建议引用了未审阅的候选')
        if (item.severity === 'important' && option.resolves && option.candidateIds.length === 0) throw new Error('重要冲突的处理缺少具体候选')
      }
      const options = item.options.map(option => ({ ...option, id: randomUUID() }))
      return { id: randomUUID(), description: item.description, severity: item.severity, evidence: item.evidence, options,
        recommendedOptionId: item.recommendedIndex === null ? null : options[item.recommendedIndex]!.id }
    })
    const dependencies = z.array(dependencySchema).parse(input.dependencies)
    for (const dependency of dependencies) if (!unique(dependency.candidateIds) || dependency.candidateIds.some(id => !candidateIds.has(id))) throw new Error('依赖引用了未审阅或重复的候选')
    const value = reviewSchema.parse({ formatVersion: 1, worldId: this.world.worldId, discussionId, id: randomUUID(), createdAt: new Date().toISOString(), reports, findings, dependencies })
    validateReview(value)
    return { value, version: await this.publish('reviews', value.id, value) }
  }) }

  /** 按可信讨论读取审阅快照及内容摘要，供应用展示。 */
  read(discussionId: string, id: string) { return this.enqueue(async () => {
    const result = await this.load('reviews', id, reviewSchema)
    if (result.value.id !== id || result.value.worldId !== this.world.worldId || result.value.discussionId !== discussionId) throw new Error('审阅身份不匹配')
    validateReview(result.value)
    return result
  }) }

  /**
   * 记录可信应用收到的明确用户确认；不发布当前资料。
   * @param discussionId 可信讨论 ID。
   * @param reviewId 用户实际审阅的快照 ID。
   * @param input 审阅版本、显式选项、用户选定候选及对未覆盖范围的逐项知悉。
   * @returns 已保存的确认记录及摘要；不能仅凭该记录跳过提交前重新核验。
   * @throws 检查失败、版本变化、重要冲突未处理、默认建议不可执行或用户动作不完整时拒绝。
   */
  confirm(discussionId: string, reviewId: string, input: { reviewVersion: string; confirmContinue: true;
    selectedCandidateIds: readonly string[]; selections: readonly { findingId: string; optionId: string }[];
    acknowledgedUncovered: readonly { reportId: string; scope: string }[] }) { return this.enqueue(async () => {
    if (input.confirmContinue !== true) throw new Error('需要用户明确确认继续')
    const review = await this.load('reviews', reviewId, reviewSchema); const value = review.value
    if (review.version !== input.reviewVersion || value.id !== reviewId || value.worldId !== this.world.worldId || value.discussionId !== discussionId) throw new Error('审阅身份或版本已变化')
    validateReview(value)
    const selected = z.array(uuid).min(1).parse(input.selectedCandidateIds)
    const selections = z.array(selectionSchema).parse(input.selections)
    const acknowledged = z.array(uncoveredSchema).parse(input.acknowledgedUncovered)
    if (!unique(selected) || !unique(selections.map(item => item.findingId)) || !unique(acknowledged.map(scopeKey))) throw new Error('用户选择或知悉项重复')
    const available = new Set(value.reports.map(item => item.report.candidateId))
    if (selected.some(id => !available.has(id))) throw new Error('选择包含未审阅候选')
    if (selections.some(item => !value.findings.some(finding => finding.id === item.findingId))) throw new Error('选择包含未知检查项')
    for (const dependency of value.dependencies) {
      const count = dependency.candidateIds.filter(id => selected.includes(id)).length
      if (count !== 0 && count !== dependency.candidateIds.length) throw new Error(`选择会造成已知不一致：${dependency.reason}`)
    }
    const uncovered = value.reports.flatMap(({ report }) => report.scopes.filter(scope => scope.status === 'uncovered').map(scope => ({ reportId: report.id, scope: scope.name })))
    if (acknowledged.some(item => !uncovered.some(scope => scopeKey(scope) === scopeKey(item))) || uncovered.some(item => !acknowledged.some(scope => scopeKey(scope) === scopeKey(item)))) throw new Error('必须明确知悉全部未覆盖范围')
    const choices = value.findings.map(finding => {
      const explicit = selections.find(item => item.findingId === finding.id)
      const optionId = explicit?.optionId ?? finding.recommendedOptionId
      const option = finding.options.find(item => item.id === optionId)
      if (!option) throw new Error('检查项缺少有效选择或可执行建议')
      if (finding.severity === 'important' && !option.resolves) throw new Error('重要冲突尚未处理')
      if (option.candidateIds.some(id => !selected.includes(id))) throw new Error('建议涉及的目标尚未逐项确认')
      return { findingId: finding.id, optionId: option.id, origin: explicit ? 'explicit' as const : 'recommended' as const }
    })
    for (const { report, version } of value.reports) {
      if (report.status !== 'completed' || report.scopes.some(scope => scope.status === 'failed' || scope.status === 'cancelled' || scope.status === 'changed')) throw new Error('检查未完成，不能确认')
      const actual = await this.impact.read(discussionId, report.id)
      if (actual.version !== version || JSON.stringify(actual.report) !== JSON.stringify(report)) throw new Error('审阅中的检查报告与原报告不一致')
      const result = await this.impact.verify(discussionId, report.id, version)
      if (result.status !== 'current') throw new Error(`检查报告需要重新检查：${result.reason}`)
    }
    const confirmation = confirmationSchema.parse({ formatVersion: 1, worldId: this.world.worldId, discussionId, reviewId, reviewVersion: review.version,
      createdAt: new Date().toISOString(), selectedCandidateIds: selected, acknowledgedUncovered: acknowledged, choices })
    return { value: confirmation, version: await this.publish('confirmations', reviewId, confirmation) }
  }) }

  /** 核查某次审阅已保存的确认，不表示已经提交。 */
  readConfirmation(discussionId: string, reviewId: string) { return this.enqueue(async () => {
    const result = await this.load('confirmations', reviewId, confirmationSchema)
    if (result.value.reviewId !== reviewId || result.value.worldId !== this.world.worldId || result.value.discussionId !== discussionId) throw new Error('确认身份不匹配')
    return result
  }) }

  /** 停止新请求，等待已受理操作并释放进程内占用。 */
  close(): Promise<void> {
    if (!this.closing) { this.closed = true; this.closing = (async () => { await this.operations.drain(); occupiedWorlds.delete(this.world.worldId); occupiedRoots.delete(this.root) })() }
    return this.closing
  }
}
