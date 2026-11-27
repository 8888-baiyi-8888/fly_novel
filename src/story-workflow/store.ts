import { lstat, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { mapProposalKeySchema, mapProposalRecordSchema, mapSceneCheckSchema, type MapProposalRecord, type MapSceneCheck } from './map-scene.js'
import { storyNoticeSchema, storyProgressSchema, type StoryNotice, type StoryProgress } from './types.js'
import { sceneOrderSchema, sceneResultRecordSchema, sceneSetupRecordSchema, type SceneResultInput, type SceneResultRecord, type SceneSetupRecord } from './types.js'
import { collaborationSchema, parseStrictJson, planRecordSchema, simulationRecordSchema, siblingRunSchema, siblingDecisionSchema, storyNodeSchema, storyStepSchema, storyChoiceSchema, type Collaboration, type PlanRecord, type SimulationRecord, type SiblingDecision, type StoryNode, type StoryStep, type StoryChoice } from './types.js'

const uuid = z.string().uuid()
const key = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path
function within(parent: string, child: string): boolean {
  const rel = relative(key(parent), key(child))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** 独立规划记录：仅创建与读取，调用方保证列出所有需要隔离的业务根。 */
export class PlanStore {
  private constructor(private readonly root: string) {}

  /** 打开现有真实目录；禁止与调用方提供的受保护目录重叠。 */
  static async open(root: string, protectedRoots: readonly string[]): Promise<PlanStore> {
    async function directory(path: string): Promise<string> {
      if (!isAbsolute(path)) throw new Error('目录必须是绝对路径')
      const resolved = await realpath(path)
      if (key(resolved) !== key(resolve(path)) || !(await lstat(resolved)).isDirectory()) throw new Error('目录必须是现有真实目录')
      return resolved
    }
    const realRoot = await directory(root)
    for (const path of protectedRoots) {
      const protectedRoot = await directory(path)
      if (within(realRoot, protectedRoot) || within(protectedRoot, realRoot)) throw new Error('规划目录与受保护目录重叠')
    }
    return new PlanStore(realRoot)
  }

  private path(id: string): string { return join(this.root, `${uuid.parse(id)}.json`) }

  /** 独占创建记录；失败保留原文件，错误包含运行 ID 以便核查。 */
  async save(record: PlanRecord): Promise<void> {
    const value = planRecordSchema.parse(record)
    const content = `${JSON.stringify(value, null, 2)}\n`
    if (Buffer.byteLength(content) > 1024 * 1024) throw new Error('规划记录超过大小限制')
    try { await writeFile(this.path(value.id), content, { encoding: 'utf8', flag: 'wx' }) }
    catch (error) { throw new Error(`规划保存失败或结果不明，请核查运行 ${value.id}`, { cause: error }) }
  }

  /** 读取并校验规划身份、版本及 JSON；损坏文件不会被修改。 */
  async read(id: string): Promise<PlanRecord> {
    const path = this.path(id)
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || key(await realpath(path)) !== key(path)) throw new Error('规划记录必须是普通文件')
    if (info.size > 1024 * 1024) throw new Error('规划记录超过大小限制')
    const bytes = await readFile(path)
    if (bytes.length > 1024 * 1024) throw new Error('规划记录超过大小限制')
    const value = planRecordSchema.parse(parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
    if (value.id !== id) throw new Error('规划运行身份不匹配')
    return value
  }
}

const claimSchema = z.object({ formatVersion: z.literal(1), planId: uuid, childStoryId: uuid, collaborationId: uuid }).strict()

/** 使用独立目录保存单个事件的独占尝试及最终协作记录。 */
export class CollaborationStore {
  private constructor(private readonly root: string) {}

  private mapCheckPath(runId: string, storyId: string, id: string): string {
    return join(this.root, `${uuid.parse(runId)}.${uuid.parse(storyId)}.${uuid.parse(id)}.map-check.json`)
  }

  async saveMapSceneCheck(check: MapSceneCheck): Promise<void> {
    const value = mapSceneCheckSchema.parse(check)
    await writeFile(this.mapCheckPath(value.runId, value.storyId, value.id), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', encoding: 'utf8' })
  }

  async readMapSceneCheck(runId: string, storyId: string, id: string): Promise<MapSceneCheck> {
    const check = mapSceneCheckSchema.parse(await this.readFile(this.mapCheckPath(runId, storyId, id)))
    if (check.runId !== runId || check.storyId !== storyId || check.id !== id) throw new Error('场景地图核查身份不匹配')
    return check
  }

  private mapProposalPath(runId: string, storyId: string, checkId: string, suffix: 'claim' | 'result'): string {
    return join(this.root, `${uuid.parse(runId)}.${uuid.parse(storyId)}.${uuid.parse(checkId)}.map-proposal-${suffix}.json`)
  }

  async claimMapProposal(runId: string, storyId: string, checkId: string): Promise<void> {
    const key = mapProposalKeySchema.parse({ formatVersion: 1, runId, storyId, checkId })
    await writeFile(this.mapProposalPath(runId, storyId, checkId, 'claim'), `${JSON.stringify(key)}\n`, { flag: 'wx', encoding: 'utf8' })
  }

  async saveMapProposal(record: MapProposalRecord): Promise<void> {
    const value = mapProposalRecordSchema.parse(record)
    const { runId, storyId, checkId } = value
    await writeFile(this.mapProposalPath(runId, storyId, checkId, 'result'), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', encoding: 'utf8' })
  }

  async readMapProposal(runId: string, storyId: string, checkId: string) {
    const claim = mapProposalKeySchema.parse(await this.readFile(this.mapProposalPath(runId, storyId, checkId, 'claim')))
    if (claim.runId !== runId || claim.storyId !== storyId || claim.checkId !== checkId) throw new Error('地图提案占用身份不匹配')
    let raw: unknown
    try { raw = await this.readFile(this.mapProposalPath(runId, storyId, checkId, 'result')) }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { ...claim, result: { status: 'pending' as const } }
      throw error
    }
    const value = mapProposalRecordSchema.parse(raw)
    if (value.runId !== runId || value.storyId !== storyId || value.checkId !== checkId) throw new Error('地图提案结果身份不匹配')
    return value
  }

  /** 调用方提供全部受保护目录；记录根不得与规划根重叠。 */
  static async open(root: string, planRoot: string, protectedRoots: readonly string[]): Promise<CollaborationStore> {
    await PlanStore.open(root, [...protectedRoots, planRoot])
    return new CollaborationStore(await realpath(root))
  }

  private path(planId: string, childStoryId: string, kind: 'claim' | 'simulation' | 'result'): string {
    return join(this.root, `${uuid.parse(planId)}.${uuid.parse(childStoryId)}.${kind}.json`)
  }

  private progressPath(runId: string, batch: number, kind: 'paused' | 'continued'): string {
    return join(this.root, `${uuid.parse(runId)}.${z.number().int().positive().parse(batch)}.${kind}.story.json`)
  }

  /** 独占保存提前汇报或上级决定，决定必须对应已保存的汇报。 */
  async saveStoryNotice(notice: StoryNotice): Promise<void> {
    const value = storyNoticeSchema.parse(notice)
    const { runId, storyId, parentStoryId, noticeId, kind } = value
    const node = await this.readStoryNode(runId, storyId)
    if (node.parentStoryId !== parentStoryId) throw new Error('提前汇报的上级身份不匹配')
    if (kind === 'decision') {
      const report = await this.readStoryNotice(runId, storyId, noticeId, 'report')
      if (report.parentStoryId !== parentStoryId) throw new Error('提前汇报与决定的上级身份不匹配')
    }
    const content = `${JSON.stringify(value, null, 2)}\n`
    if (Buffer.byteLength(content) > 1024 * 1024) throw new Error('提前汇报记录超过大小限制')
    await writeFile(join(this.root, `${runId}.${storyId}.${noticeId}.notice-${kind}.json`), content, { flag: 'wx', encoding: 'utf8' })
  }

  /** 读取提前汇报或上级决定，并核对故事和通知身份。 */
  async readStoryNotice(runId: string, storyId: string, noticeId: string, kind: StoryNotice['kind']): Promise<StoryNotice> {
    const path = join(this.root, `${uuid.parse(runId)}.${uuid.parse(storyId)}.${uuid.parse(noticeId)}.notice-${kind}.json`)
    const value = storyNoticeSchema.parse(await this.readFile(path))
    if (value.runId !== runId || value.storyId !== storyId || value.noticeId !== noticeId || value.kind !== kind) throw new Error('提前汇报记录身份不匹配')
    return value
  }

  /** 保存本次正常暂停的推进位置。 */
  async saveStoryProgress(progress: StoryProgress): Promise<void> {
    const value = storyProgressSchema.parse(progress)
    const content = `${JSON.stringify(value, null, 2)}\n`
    if (Buffer.byteLength(content) > 1024 * 1024) throw new Error('故事暂停记录超过大小限制')
    await writeFile(this.progressPath(value.runId, value.batch, 'paused'), content, { flag: 'wx', encoding: 'utf8' })
  }

  /** 读取有版本的暂停记录并核对所属运行及批次。 */
  async readStoryProgress(runId: string, batch: number): Promise<StoryProgress> {
    const value = storyProgressSchema.parse(await this.readFile(this.progressPath(runId, batch, 'paused')))
    const rootId = await this.readRootStoryId(runId)
    if (value.runId !== runId || value.batch !== batch || value.frames[0]?.node.storyId !== rootId) throw new Error('故事暂停记录身份不匹配')
    return value
  }

  /** 从运行记录取得本轮根故事身份。 */
  async readRootStoryId(runId: string): Promise<string> {
    const run = siblingRunSchema.parse(await this.readFile(join(this.root, `${uuid.parse(runId)}.siblings.json`)))
    if (run.planId !== runId) throw new Error('故事运行记录身份不匹配')
    return run.parentStoryId
  }

  /** 每个暂停位置只允许开始一次继续操作，失败后保留标记供核查。 */
  async claimStoryProgress(runId: string, batch: number): Promise<void> {
    try { await writeFile(this.progressPath(runId, batch, 'continued'), '', { flag: 'wx' }) }
    catch (error) { throw new Error(`故事暂停位置已使用或占用结果不明，请核查批次 ${batch}`, { cause: error }) }
  }

  /** 查找该运行最新的暂停或消费记录编号。 */
  async latestStoryBatch(runId: string): Promise<number | undefined> {
    const prefix = `${uuid.parse(runId)}.`
    let latest: number | undefined
    for (const name of await readdir(this.root)) {
      if (!name.startsWith(prefix)) continue
      const match = /^(\d+)\.(paused|continued)\.story\.json$/.exec(name.slice(prefix.length))
      if (!match) continue
      const batch = Number(match[1])
      if (!Number.isSafeInteger(batch) || batch < 1 || String(batch) !== match[1]) throw new Error('故事批次文件编号无效')
      if (latest === undefined || batch > latest) latest = batch
    }
    return latest
  }

  /** 检查计划或具体故事是否已有推进文件，包含部分写入后遗留的证据。 */
  async hasStoryRecords(runId: string, storyId?: string): Promise<boolean> {
    const prefix = storyId === undefined ? `${uuid.parse(runId)}.` : this.scenePrefix(runId, storyId)
    return (await readdir(this.root)).some(name => name.startsWith(prefix))
  }

  /** 只读查看批次是否已经领取，校验空消费标记。 */
  async hasContinuedStoryProgress(runId: string, batch: number): Promise<boolean> {
    const path = this.progressPath(runId, batch, 'continued')
    try {
      const info = await lstat(path)
      if (!info.isFile() || info.size !== 0 || key(await realpath(path)) !== key(path)) throw new Error('故事暂停消费标记无效')
      return true
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
      throw error
    }
  }

  /** 读取已处理子故事的决定并核对身份。 */
  async readStoryChoice(runId: string, childStoryId: string): Promise<StoryChoice> {
    const value = storyChoiceSchema.parse(await this.readFile(join(this.root, `${uuid.parse(runId)}.${uuid.parse(childStoryId)}.choice.story.json`)))
    if (value.runId !== runId || value.childStoryId !== childStoryId) throw new Error('故事决定身份不匹配')
    return value
  }

  /** 独占保存故事及其直接上级，确保上级属于同一轮运行。 */
  async saveStoryNode(node: StoryNode): Promise<void> {
    const value = storyNodeSchema.parse(node)
    if (value.parentStoryId !== null) {
      await this.readStoryNode(value.runId, value.parentStoryId)
    }
    const content = `${JSON.stringify(value, null, 2)}\n`
    if (Buffer.byteLength(content) > 1024 * 1024) throw new Error('故事记录超过大小限制')
    try { await writeFile(join(this.root, `${value.runId}.${value.storyId}.story.json`), content, { flag: 'wx', encoding: 'utf8' }) }
    catch (error) { throw new Error(`故事保存失败或结果不明，请核查故事 ${value.storyId}`, { cause: error }) }
  }

  /** 读取故事并核对运行及故事身份；损坏或未知版本不会被覆盖。 */
  async readStoryNode(runId: string, storyId: string): Promise<StoryNode> {
    const value = storyNodeSchema.parse(await this.readFile(join(this.root, `${uuid.parse(runId)}.${uuid.parse(storyId)}.story.json`)))
    if (value.runId !== runId || value.storyId !== storyId) throw new Error('故事记录身份不匹配')
    return value
  }

  /** 依次独占保存拆分判断、模拟经过或回报。 */
  async saveStoryStep(step: StoryStep): Promise<void> {
    const value = storyStepSchema.parse(step)
    await this.readStoryNode(value.runId, value.storyId)
    await this.verifySceneReferences(value)
    const content = `${JSON.stringify(value, null, 2)}\n`
    if (Buffer.byteLength(content) > 1024 * 1024) throw new Error('故事步骤记录超过大小限制')
    try { await writeFile(join(this.root, `${value.runId}.${value.storyId}.${value.kind}.story.json`), content, { flag: 'wx', encoding: 'utf8' }) }
    catch (error) { throw new Error(`故事步骤保存失败或结果不明，请核查故事 ${value.storyId}`, { cause: error }) }
  }

  /** 读取步骤并核对身份及版本。 */
  async readStoryStep(runId: string, storyId: string, kind: StoryStep['kind']): Promise<StoryStep> {
    const value = storyStepSchema.parse(await this.readFile(join(this.root, `${uuid.parse(runId)}.${uuid.parse(storyId)}.${kind}.story.json`)))
    if (value.runId !== runId || value.storyId !== storyId || value.kind !== kind) throw new Error('故事步骤身份不匹配')
    await this.verifySceneReferences(value)
    return value
  }

  private async verifySceneReferences(step: StoryStep): Promise<void> {
    if (step.kind !== 'result' || step.formatVersion !== 2) return
    const decision = await this.readStoryStep(step.runId, step.storyId, 'decision')
    if (decision.kind !== 'decision' || decision.value.kind !== 'direct') {
      throw new Error(`场景回报须归属直接演绎的故事：${step.storyId}`)
    }
    const results = await this.readSettledScenes(step.runId, step.storyId)
    if (results.length !== step.sceneIds.length || results.some((result, index) => result.sceneId !== step.sceneIds[index])) {
      throw new Error(`子故事回报的场景引用不匹配：${step.storyId}`)
    }
  }

  private scenePrefix(runId: string, storyId: string): string {
    return `${uuid.parse(runId)}.${uuid.parse(storyId)}.`
  }

  /** 故事级模拟已写入后，场景清单用于形成或核查回报。 */
  private async assertSceneSetupOpen(runId: string, storyId: string): Promise<void> {
    try {
      await this.readStoryStep(runId, storyId, 'simulation')
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
      throw error
    }
    throw new Error(`故事模拟已经保存，不能追加场景：${storyId}`)
  }

  /** 独占保存场景设置。程序按运行、故事和顺序分配场景身份。 */
  async saveSceneSetup(input: Omit<SceneSetupRecord, 'sceneId' | 'formatVersion'>): Promise<SceneSetupRecord> {
    const { runId, storyId, order } = input
    const sceneId = this.scenePrefix(runId, storyId) + sceneOrderSchema.parse(order)
    const record = sceneSetupRecordSchema.parse({ ...input, sceneId, formatVersion: 1 })
    const content = `${JSON.stringify(record, null, 2)}\n`
    if (Buffer.byteLength(content) > 1024 * 1024) throw new Error('场景设置超过大小限制')
    await this.assertSceneSetupOpen(runId, storyId)
    try {
      await writeFile(join(this.root, `${sceneId}.setup.scene.json`), content, { flag: 'wx', encoding: 'utf8' })
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        throw new Error(`场景身份及顺序已占用：${sceneId}`, { cause: error })
      }
      throw new Error(`场景设置保存失败或结果不明，请核查场景 ${sceneId}`, { cause: error })
    }
    return record
  }

  /** 读取并核对文件名与场景所属运行、故事和顺序。 */
  async readSceneSetup(runId: string, storyId: string, sceneId: string): Promise<SceneSetupRecord> {
    const prefix = this.scenePrefix(runId, storyId)
    if (!sceneId.startsWith(prefix)) throw new Error(`场景不属于指定的运行与故事：${sceneId}`)
    const order = sceneOrderSchema.parse(Number(sceneId.slice(prefix.length)))
    if (sceneId !== prefix + order) throw new Error(`场景身份无效：${sceneId}`)
    const record = sceneSetupRecordSchema.parse(await this.readFile(join(this.root, `${sceneId}.setup.scene.json`)))
    if (record.sceneId !== sceneId || record.runId !== runId || record.storyId !== storyId || record.order !== order) {
      throw new Error(`场景记录身份不匹配：${sceneId}`)
    }
    return record
  }

  /** 按故事列出已保存的场景设置，按顺序号升序返回。 */
  async listSceneSetups(runId: string, storyId: string): Promise<SceneSetupRecord[]> {
    const prefix = this.scenePrefix(runId, storyId)
    const suffix = '.setup.scene.json'
    const scenes: SceneSetupRecord[] = []
    for (const name of await readdir(this.root)) {
      if (name.startsWith(prefix) && name.endsWith(suffix)) {
        scenes.push(await this.readSceneSetup(runId, storyId, name.slice(0, -suffix.length)))
      }
    }
    return scenes.sort((a, b) => a.order - b.order)
  }

  /** 仅为已保存的设置独占写入一份模拟结果。 */
  async saveSceneResult(runId: string, storyId: string, sceneId: string, input: SceneResultInput): Promise<SceneResultRecord> {
    await this.readSceneSetup(runId, storyId, sceneId)
    const record = sceneResultRecordSchema.parse({ ...input, formatVersion: 1, runId, storyId, sceneId })
    const content = `${JSON.stringify(record, null, 2)}\n`
    if (Buffer.byteLength(content) > 1024 * 1024) throw new Error('场景结果超过大小限制')
    try {
      await writeFile(join(this.root, `${sceneId}.result.scene.json`), content, { flag: 'wx', encoding: 'utf8' })
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        throw new Error(`场景结果已存在：${sceneId}`, { cause: error })
      }
      throw new Error(`场景结果保存失败或结果不明，请核查场景 ${sceneId}`, { cause: error })
    }
    return record
  }

  /** 重读已验证设置的模拟结果，结果不存在时返回 undefined。 */
  async readSceneResult(setup: SceneSetupRecord): Promise<SceneResultRecord | undefined> {
    const { runId, storyId, order } = setup
    const sceneId = this.scenePrefix(runId, storyId) + sceneOrderSchema.parse(order)
    let data: unknown
    try {
      data = await this.readFile(join(this.root, `${sceneId}.result.scene.json`))
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
      throw error
    }
    const result = sceneResultRecordSchema.parse(data)
    if (result.sceneId !== sceneId || result.runId !== runId || result.storyId !== storyId) {
      throw new Error(`场景结果身份不匹配：${sceneId}`)
    }
    return result
  }

  /** 读取按顺序结算的场景。缺少结果或结果未决时拒绝形成回报。 */
  async readSettledScenes(runId: string, storyId: string): Promise<SceneResultRecord[]> {
    const results: SceneResultRecord[] = []
    for (const setup of await this.listSceneSetups(runId, storyId)) {
      const result = await this.readSceneResult(setup)
      if (!result || result.status === 'unresolved') throw new Error(`场景尚未结算：${setup.sceneId}`)
      results.push(result)
    }
    return results
  }

  /** 记录上级对当前未执行子故事的决定，包括取消。 */
  async saveStoryChoice(choice: StoryChoice): Promise<void> {
    const value = storyChoiceSchema.parse(choice)
    await this.readStoryNode(value.runId, value.parentStoryId)
    const content = `${JSON.stringify(value, null, 2)}\n`
    if (Buffer.byteLength(content) > 1024 * 1024) throw new Error('故事决定超过大小限制')
    try { await writeFile(join(this.root, `${value.runId}.${value.childStoryId}.choice.story.json`), content, { flag: 'wx', encoding: 'utf8' }) }
    catch (error) { throw new Error(`故事决定保存失败或结果不明，请核查故事 ${value.childStoryId}`, { cause: error }) }
  }

  /** 独占创建本轮父故事身份，避免将已有尝试自动当成可恢复进度。 */
  async startSiblings(planId: string, parentStoryId: string): Promise<void> {
    const value = siblingRunSchema.parse({ formatVersion: 1, planId, parentStoryId })
    try { await writeFile(join(this.root, `${value.planId}.siblings.json`), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', encoding: 'utf8' }) }
    catch (error) { throw new Error(`兄弟故事已有运行或创建结果不明，请核查规划 ${planId}`, { cause: error }) }
  }

  /** 保存每个未发生事件的导演决定；已保存决定不会被覆盖。 */
  async saveSiblingDecision(decision: SiblingDecision): Promise<void> {
    const value = siblingDecisionSchema.parse(decision)
    const run = siblingRunSchema.parse(await this.readFile(join(this.root, `${value.planId}.siblings.json`)))
    if (run.planId !== value.planId || run.parentStoryId !== value.parentStoryId) throw new Error('兄弟故事身份不匹配')
    try { await writeFile(join(this.root, `${value.planId}.${value.childStoryId}.decision.json`), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', encoding: 'utf8' }) }
    catch (error) { throw new Error(`决定保存失败或结果不明，请核查事件 ${value.childStoryId}`, { cause: error }) }
  }

  /** 读取并核对兄弟故事决定与本轮父故事身份。 */
  async readSiblingDecision(planId: string, childStoryId: string): Promise<SiblingDecision> {
    const run = siblingRunSchema.parse(await this.readFile(join(this.root, `${uuid.parse(planId)}.siblings.json`)))
    const value = siblingDecisionSchema.parse(await this.readFile(join(this.root, `${uuid.parse(planId)}.${uuid.parse(childStoryId)}.decision.json`)))
    if (run.planId !== planId || value.planId !== planId || value.childStoryId !== childStoryId || value.parentStoryId !== run.parentStoryId) throw new Error('兄弟故事决定身份不匹配')
    return value
  }

  /** 保存模拟经过供中断后核查；不代表子故事完成。 */
  async saveSimulation(record: SimulationRecord): Promise<void> {
    const valid = simulationRecordSchema.parse(record)
    const claim = claimSchema.parse(await this.readFile(this.path(valid.planId, valid.childStoryId, 'claim')))
    if (claim.planId !== valid.planId || claim.childStoryId !== valid.childStoryId || claim.collaborationId !== valid.collaborationId) throw new Error('协作占用身份不匹配')
    const content = `${JSON.stringify(valid, null, 2)}\n`
    if (Buffer.byteLength(content) > 1024 * 1024) throw new Error('模拟记录超过大小限制')
    try { await writeFile(this.path(valid.planId, valid.childStoryId, 'simulation'), content, { flag: 'wx', encoding: 'utf8' }) }
    catch (error) { throw new Error(`模拟记录写入失败或不明，请核查事件 ${valid.childStoryId}`, { cause: error }) }
  }

  /** 读取模拟经过并核对占用身份。 */
  async readSimulation(planId: string, childStoryId: string): Promise<SimulationRecord> {
    const claim = claimSchema.parse(await this.readFile(this.path(planId, childStoryId, 'claim')))
    const record = simulationRecordSchema.parse(await this.readFile(this.path(planId, childStoryId, 'simulation')))
    if (claim.planId !== planId || claim.childStoryId !== childStoryId || record.planId !== planId || record.childStoryId !== childStoryId || record.collaborationId !== claim.collaborationId) throw new Error('模拟记录身份不匹配')
    return record
  }

  /** 在执行导演或模拟器之前独占占用；失败后保留，禁止自动重试。 */
  async claim(planId: string, childStoryId: string, collaborationId: string): Promise<void> {
    const claim = claimSchema.parse({ formatVersion: 1, planId, childStoryId, collaborationId })
    try { await writeFile(this.path(planId, childStoryId, 'claim'), `${JSON.stringify(claim, null, 2)}\n`, { flag: 'wx', encoding: 'utf8' }) }
    catch (error) { throw new Error(`事件已有尝试或占用结果不明，请核查事件 ${childStoryId}`, { cause: error }) }
  }

  private async readFile(path: string): Promise<unknown> {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || key(await realpath(path)) !== key(path) || info.size > 1024 * 1024) throw new Error('协作记录文件无效')
    const bytes = await readFile(path)
    if (bytes.length > 1024 * 1024) throw new Error('协作记录超过大小限制')
    return parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  }

  /** 独占保存最终结果；失败时保留文件和占用供核查。 */
  async save(record: Collaboration): Promise<void> {
    const valid = collaborationSchema.parse(record)
    const claim = claimSchema.parse(await this.readFile(this.path(valid.plan.id, valid.childStoryId, 'claim')))
    if (claim.planId !== valid.plan.id || claim.childStoryId !== valid.childStoryId || claim.collaborationId !== valid.id) throw new Error('协作占用身份不匹配')
    const simulation = await this.readSimulation(valid.plan.id, valid.childStoryId)
    if (JSON.stringify(simulation.simulation) !== JSON.stringify(valid.simulation) || JSON.stringify(simulation.task) !== JSON.stringify(valid.task) || simulation.preparation !== valid.preparation) throw new Error('模拟经过与协作结果不一致')
    const content = `${JSON.stringify(valid, null, 2)}\n`
    if (Buffer.byteLength(content) > 1024 * 1024) throw new Error('协作记录超过大小限制')
    try { await writeFile(this.path(valid.plan.id, valid.childStoryId, 'result'), content, { flag: 'wx', encoding: 'utf8' }) }
    catch (error) { throw new Error(`协作结果写入失败或不明，请核查事件 ${valid.childStoryId}`, { cause: error }) }
  }

  /** 读取并核对记录与占用身份；未知版本或损坏保留原文件。 */
  async read(planId: string, childStoryId: string): Promise<Collaboration> {
    const claim = claimSchema.parse(await this.readFile(this.path(planId, childStoryId, 'claim')))
    const record = collaborationSchema.parse(await this.readFile(this.path(planId, childStoryId, 'result')))
    if (claim.planId !== planId || claim.childStoryId !== childStoryId || record.plan.id !== planId || record.childStoryId !== childStoryId || record.id !== claim.collaborationId) throw new Error('协作记录身份不匹配')
    const simulation = await this.readSimulation(planId, childStoryId)
    if (JSON.stringify(simulation.simulation) !== JSON.stringify(record.simulation) || JSON.stringify(simulation.task) !== JSON.stringify(record.task) || simulation.preparation !== record.preparation) throw new Error('模拟经过与协作结果不一致')
    return record
  }
}
