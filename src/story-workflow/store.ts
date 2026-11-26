import { lstat, readFile, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { collaborationSchema, parseStrictJson, planRecordSchema, simulationRecordSchema, siblingRunSchema, siblingDecisionSchema, type Collaboration, type PlanRecord, type SimulationRecord, type SiblingDecision } from './types.js'

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

  /** 调用方提供全部受保护目录；记录根不得与规划根重叠。 */
  static async open(root: string, planRoot: string, protectedRoots: readonly string[]): Promise<CollaborationStore> {
    await PlanStore.open(root, [...protectedRoots, planRoot])
    return new CollaborationStore(await realpath(root))
  }

  private path(planId: string, childStoryId: string, kind: 'claim' | 'simulation' | 'result'): string {
    return join(this.root, `${uuid.parse(planId)}.${uuid.parse(childStoryId)}.${kind}.json`)
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
