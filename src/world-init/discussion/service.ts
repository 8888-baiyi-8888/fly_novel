import { randomUUID } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { parseDocument } from 'yaml'
import { z } from 'zod'
import type { FileSystem, FsVersion } from '@fly-novel/fs'
import { isPathUnder } from '@fly-novel/fs-sandbox'
import { kindSchema as developmentKindSchema } from '@fly-novel/world-development'
import { specificKindSchema } from '@fly-novel/world-specific'

const uuid = z.string().uuid()
const targetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('place'), id: uuid }).strict(),
  z.object({ kind: z.literal('character'), id: uuid }).strict(),
  z.object({ kind: z.literal('character-relationship'), id: uuid }).strict(),
  z.object({ kind: z.literal('organization-membership'), id: uuid }).strict(),
  z.object({ kind: z.literal('organization'), id: uuid }).strict(),
  z.object({ kind: z.literal('organization-relation'), id: uuid }).strict(),
  z.object({ kind: z.literal('history-event'), id: uuid }).strict(),
  z.object({ kind: z.literal('file'), ownerAgentId: z.string().trim().min(1), path: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal('situation-start') }).strict(),
  z.object({ kind: z.literal('situation'), documentKind: z.enum(['overview', 'situation']), id: uuid }).strict(),
  z.object({ kind: z.literal('development'), documentKind: developmentKindSchema, id: uuid }).strict(),
  z.object({ kind: z.literal('specific'), documentKind: specificKindSchema, id: uuid }).strict(),
])
export type DiscussionTarget = z.infer<typeof targetSchema>
/** 校验并规范化可信应用选择的目标标识。 */
export function parseDiscussionTarget(value: unknown): DiscussionTarget { return targetSchema.parse(value) }
const discussionSchema = z.object({ formatVersion: z.literal(1), worldId: z.string().min(1), id: uuid,
  target: targetSchema, sessionId: z.string().min(1) }).strict()
const candidateSchema = z.object({ formatVersion: z.literal(1), worldId: z.string().min(1), id: uuid,
  discussionId: uuid, target: targetSchema, status: z.enum(['active', 'abandoned']), baseline: z.string().min(1),
  content: z.string(), summary: z.string().trim().min(1) }).strict()
type Candidate = z.infer<typeof candidateSchema>
const occupiedWorlds = new Set<string>()
const occupiedRoots = new Set<string>()

/** 由所属模块装配的读取、旧候选检查及正文校验能力。 */
export interface DiscussionTargetAdapter {
  read(target: DiscussionTarget): Promise<{ content: string; version: string }>
  assertNoLegacyCandidate(target: DiscussionTarget): Promise<void>
  validateStored(target: DiscussionTarget, content: string): Promise<void>
  validate(target: DiscussionTarget, content: string): Promise<void>
}

/** 单世界讨论记录；调用者负责文件系统和模块适配器的生命周期。 */
export class DiscussionService {
  private tail: Promise<void> = Promise.resolve()
  private closed = false
  private closing?: Promise<void>
  private constructor(private readonly worldId: string, private readonly root: string, private readonly fs: FileSystem,
    private readonly adapter: DiscussionTargetAdapter) {}

  /** 可信应用用于核对服务与世界装配。 */
  get boundWorldId(): string { return this.worldId }
  /** 供可信应用验证候选根与其他授权范围不重叠。 */
  get rootDirectory(): string { return this.root }

  /** 打开已准备的隔离目录；调用者必须保证单可信写入进程。 */
  static async open(options: { worldId: string; root: string; worldRoots: readonly string[]; fs: FileSystem;
    adapter: DiscussionTargetAdapter; singleWriterProcess: true }): Promise<DiscussionService> {
    if (options.singleWriterProcess !== true || !options.worldId.trim()) throw new Error('讨论世界或单进程写入保证无效')
    if (!isAbsolute(options.root) || await realpath(options.root) !== resolve(options.root) || !(await lstat(options.root)).isDirectory()) throw new Error('讨论根必须是现有真实绝对目录')
    for (const root of options.worldRoots) if (await isPathUnder(root, options.root) || await isPathUnder(options.root, root)) throw new Error('讨论根不能与世界读取根重叠')
    for (const name of ['discussions', 'candidates']) {
      const path = join(options.root, name); const info = await lstat(path)
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) throw new Error('讨论子目录必须是现有真实目录')
    }
    const rootKey = process.platform === 'win32' ? options.root.toLowerCase() : options.root
    if (occupiedWorlds.has(options.worldId) || occupiedRoots.has(rootKey)) throw new Error('讨论服务已打开')
    occupiedWorlds.add(options.worldId); occupiedRoots.add(rootKey)
    return new DiscussionService(options.worldId, rootKey, options.fs, options.adapter)
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('讨论服务已关闭'))
    const result = this.tail.then(fn); this.tail = result.then(() => undefined, () => undefined); return result
  }

  private async file(folder: 'discussions' | 'candidates', id: string) {
    uuid.parse(id)
    const path = join(this.root, folder, `${id}.json`)
    const info = await this.fs.lstat(path)
    if (info && info.type !== 'file') throw new Error('讨论记录必须是普通文件')
    const target = await this.fs.resolve(path)
    const parent = await this.fs.resolve(join(this.root, folder))
    if (!this.fs.contains(parent, target)) throw new Error('讨论记录路径越界')
    return target
  }

  private async read<T>(folder: 'discussions' | 'candidates', id: string, schema: z.ZodType<T>): Promise<{ value: T; version: FsVersion }> {
    const target = await this.file(folder, id); const before = await this.fs.stat(target)
    if (!before || before.type !== 'file') throw new Error('讨论记录不存在')
    const bytes = await this.fs.readBytes(target, undefined, 1024 * 1024)
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const parsed = parseDocument(text, { uniqueKeys: true })
    if (parsed.errors.length) throw new Error('讨论记录格式无效')
    const value = schema.parse(JSON.parse(text))
    const after = await this.fs.stat(target)
    if (!after || after.version !== before.version) throw new Error('讨论记录读取期间发生变化')
    return { value, version: after.version }
  }

  private async publish(folder: 'discussions' | 'candidates', id: string, value: unknown, version?: FsVersion): Promise<FsVersion> {
    const text = `${JSON.stringify(value, null, 2)}\n`
    if (Buffer.byteLength(text, 'utf8') > 1024 * 1024) throw new Error('讨论记录超出大小限制')
    const target = await this.file(folder, id)
    try { return (await this.fs.writeText(target, text, version ? { kind: 'replaceIfVersion', version } : { kind: 'createIfAbsent' })).version }
    catch (error) {
      if (error instanceof Error && 'code' in error && ['FS_STALE_VERSION', 'FS_NOT_OBSERVED', 'FS_ABORTED'].includes(String(error.code))) throw error
      throw new Error(`讨论记录发布结果不确定：${folder}/${id}.json`, { cause: error })
    }
  }

  private async candidates(): Promise<Candidate[]> {
    const dir = await this.fs.resolve(join(this.root, 'candidates')); const entries = await this.fs.listDir(dir)
    if (entries.length > 10000) throw new Error('候选数量超出限制')
    const result: Candidate[] = []
    for (const entry of entries) {
      if (entry.type !== 'file' || !/^[0-9a-f-]{36}\.json$/.test(entry.name)) throw new Error('候选目录含无法识别的记录')
      const id = entry.name.slice(0, -5); const { value } = await this.read('candidates', id, candidateSchema)
      if (value.id !== id || value.worldId !== this.worldId) throw new Error('候选身份不匹配')
      await this.adapter.validateStored(value.target, value.content)
      result.push(value)
    }
    return result
  }

  /** 创建绑定当前世界和目标的讨论；Session 标识由应用提供。 */
  createDiscussion(target: DiscussionTarget, sessionId: string) { return this.enqueue(async () => {
    const value = discussionSchema.parse({ formatVersion: 1, worldId: this.worldId, id: randomUUID(), target, sessionId })
    const entries = await this.fs.listDir(await this.fs.resolve(join(this.root, 'discussions')))
    if (entries.length > 10000) throw new Error('讨论数量超出限制')
    for (const entry of entries) {
      if (entry.type !== 'file' || !/^[0-9a-f-]{36}\.json$/.test(entry.name)) throw new Error('讨论目录含无法识别的记录')
      const id = entry.name.slice(0, -5); const existing = (await this.read('discussions', id, discussionSchema)).value
      if (existing.id !== id || existing.worldId !== this.worldId) throw new Error('讨论身份不匹配')
      if (existing.sessionId === sessionId) throw new Error('Session 已属于其他讨论')
    }
    await this.adapter.read(value.target)
    await this.publish('discussions', value.id, value)
    return value
  }) }

  /** 读取并校验讨论身份。 */
  readDiscussion(id: string) { return this.enqueue(async () => {
    const result = await this.read('discussions', id, discussionSchema)
    if (result.value.id !== id || result.value.worldId !== this.worldId) throw new Error('讨论身份不匹配')
    return result.value
  }) }

  /** 读取可信应用绑定的目标正文及版本。 */
  readCurrent(discussionId: string) { return this.enqueue(async () => {
    const discussion = (await this.read('discussions', discussionId, discussionSchema)).value
    if (discussion.id !== discussionId || discussion.worldId !== this.worldId) throw new Error('讨论身份不匹配')
    return this.adapter.read(discussion.target)
  }) }

  /** 读取可信应用授权的关联目标；调用者负责限定目标选择范围。 */
  readRelated(discussionId: string, target: DiscussionTarget) { return this.enqueue(async () => {
    const discussion = (await this.read('discussions', discussionId, discussionSchema)).value
    if (discussion.id !== discussionId || discussion.worldId !== this.worldId) throw new Error('讨论身份不匹配')
    return this.adapter.read(targetSchema.parse(target))
  }) }

  /** 查询讨论保存的候选；逐项返回版本，不以索引代替正文。 */
  listCandidates(discussionId: string) { return this.enqueue(async () => {
    const discussion = (await this.read('discussions', discussionId, discussionSchema)).value
    if (discussion.id !== discussionId || discussion.worldId !== this.worldId) throw new Error('讨论身份不匹配')
    const items = (await this.candidates()).filter(item => item.discussionId === discussionId)
    return Promise.all(items.map(item => this.read('candidates', item.id, candidateSchema)))
  }) }

  /** 创建一份独占候选，基线由真实读取取得。 */
  createCandidate(discussionId: string, target: DiscussionTarget, content: string, summary: string) { return this.enqueue(async () => {
    const discussion = (await this.read('discussions', discussionId, discussionSchema)).value
    if (discussion.id !== discussionId || discussion.worldId !== this.worldId) throw new Error('讨论身份不匹配')
    const validTarget = targetSchema.parse(target)
    const current = await this.adapter.read(validTarget)
    await this.adapter.assertNoLegacyCandidate(validTarget)
    await this.adapter.validate(validTarget, content)
    if ((await this.candidates()).some(item => item.status === 'active' && JSON.stringify(item.target) === JSON.stringify(validTarget))) throw new Error('目标已有有效候选')
    const again = await this.adapter.read(validTarget)
    if (again.version !== current.version) throw new Error('当前资料已变化')
    const value = candidateSchema.parse({ formatVersion: 1, worldId: this.worldId, id: randomUUID(), discussionId,
      target: validTarget, status: 'active', baseline: current.version, content, summary })
    return { value, version: await this.publish('candidates', value.id, value) }
  }) }

  /** 读取候选及当前正文，明确基线是否过期。 */
  readCandidate(id: string) { return this.enqueue(async () => {
    const result = await this.read('candidates', id, candidateSchema)
    if (result.value.id !== id || result.value.worldId !== this.worldId) throw new Error('候选身份不匹配')
    await this.adapter.validateStored(result.value.target, result.value.content)
    const current = await this.adapter.read(result.value.target)
    return { ...result, current, stale: current.version !== result.value.baseline }
  }) }

  /** 条件更新已有候选；不会修改当前正文。 */
  updateCandidate(discussionId: string, id: string, version: string, content: string, summary: string) { return this.enqueue(async () => {
    const old = await this.read('candidates', id, candidateSchema); const value = old.value
    if (value.worldId !== this.worldId || value.id !== id || value.discussionId !== discussionId || value.status !== 'active' || old.version !== version) throw new Error('候选身份、状态或版本不匹配')
    const current = await this.adapter.read(value.target)
    if (current.version !== value.baseline) throw new Error('候选基线已过期')
    await this.adapter.assertNoLegacyCandidate(value.target)
    await this.adapter.validate(value.target, content)
    const next = candidateSchema.parse({ ...value, content, summary })
    return { value: next, version: await this.publish('candidates', id, next, old.version) }
  }) }

  /** 保留正文并标记放弃；条件写入成功后释放目标占用。 */
  abandonCandidate(discussionId: string, id: string, version: string) { return this.enqueue(async () => {
    const old = await this.read('candidates', id, candidateSchema); const value = old.value
    if (value.worldId !== this.worldId || value.id !== id || value.discussionId !== discussionId || value.status !== 'active' || old.version !== version) throw new Error('候选身份、状态或版本不匹配')
    const next = candidateSchema.parse({ ...value, status: 'abandoned' })
    return { value: next, version: await this.publish('candidates', id, next, old.version) }
  }) }

  /** 停止新请求，等待已受理请求并释放进程内占用。 */
  close(): Promise<void> {
    if (!this.closing) { this.closed = true; this.closing = (async () => { await this.tail; occupiedWorlds.delete(this.worldId); occupiedRoots.delete(this.root) })() }
    return this.closing
  }
}
