import { createHash } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { parseDocument } from 'yaml'
import { z } from 'zod'
import type { FsVersion } from '@fly-novel/fs'
import { LocalFileSystem } from '@fly-novel/fs-local'
import { isPathUnder } from '@fly-novel/fs-sandbox'
import type { WorldAccess } from '@fly-novel/util'
import { parseDiscussionTarget, type DiscussionTargetAdapter, type DiscussionTarget } from '../discussion/service.js'
import { sameWorldWorkspace, validateWorldWorkspaceConfigs, type WorldWorkspaceConfig } from '../workspace/config.js'

const uuid = z.string().uuid()
export const taskSchema = z.object({ formatVersion: z.literal(1), id: uuid, worldId: z.string().min(1), worldBinding: z.string().length(64),
  sessionIds: z.array(z.string().trim().min(1)), createdAt: z.iso.datetime() }).strict()
const artifactSchema = z.object({ target: z.unknown(), version: z.string().min(1), digest: z.string().length(64) }).strict()
export const judgmentSchema = z.object({ formatVersion: z.literal(1), id: uuid, taskId: uuid, worldId: z.string().min(1),
  createdAt: z.iso.datetime(), actor: z.enum(['user', 'trusted-workflow']), scope: z.string().trim().min(1), artifacts: z.array(artifactSchema).min(1) }).strict()
export type InitializationTask = z.infer<typeof taskSchema>
export type FirstVersionJudgment = z.infer<typeof judgmentSchema>
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
export const worldBindingFingerprint = (world: WorldWorkspaceConfig) => sha256(JSON.stringify({ ...world, agents: [...world.agents].sort((a, b) => a.agentId.localeCompare(b.agentId)) }))
const occupied = new Set<string>()

/** 新增记录只在可信应用明确调用时写入；调用者负责协调全部同世界写入口。 */
export class InitializationTaskStore {
  private closed = false
  private closing?: Promise<void>
  private constructor(private readonly world: WorldWorkspaceConfig, private readonly root: string, private readonly fs: LocalFileSystem,
    private readonly gate: WorldAccess, private readonly adapter: DiscussionTargetAdapter) {}

  static async open(options: { worlds: readonly WorldWorkspaceConfig[]; worldId: string; root: string; otherRoots: readonly string[];
    fs: LocalFileSystem; gate: WorldAccess; adapter: DiscussionTargetAdapter; singleWriterProcess: true }): Promise<InitializationTaskStore> {
    const worlds = await validateWorldWorkspaceConfigs(options.worlds)
    const world = worlds.find(item => item.worldId === options.worldId)
    if (!world || options.singleWriterProcess !== true || !(options.fs instanceof LocalFileSystem)) throw new Error('任务装配或单写入进程保证无效')
    if (!options.adapter.worldBinding || !sameWorldWorkspace(options.adapter.worldBinding, world)) throw new Error('成果适配器世界绑定不匹配')
    if (!options.gate.covers(world.readRoot) || !options.gate.covers(options.root)) throw new Error('任务协调范围不完整')
    if (!isAbsolute(options.root) || await realpath(options.root) !== resolve(options.root) || !(await lstat(options.root)).isDirectory()) throw new Error('任务根必须是现有真实绝对目录')
    for (const root of [...worlds.map(item => item.readRoot), ...options.otherRoots]) {
      if (!isAbsolute(root) || await realpath(root) !== resolve(root) || !(await lstat(root)).isDirectory()) throw new Error('其他根必须是现有真实绝对目录')
      if (await isPathUnder(root, options.root) || await isPathUnder(options.root, root)) throw new Error('任务根与其他根重叠')
    }
    for (const name of ['tasks', 'first-versions']) {
      const path = join(options.root, name); const info = await lstat(path)
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) throw new Error('任务记录目录必须是现有真实目录')
    }
    const key = process.platform === 'win32' ? options.root.toLowerCase() : options.root
    if (occupied.has(key)) throw new Error('任务根已打开')
    occupied.add(key)
    return new InitializationTaskStore(world, key, options.fs, options.gate, options.adapter)
  }

  private check(): void { if (this.closed || this.closing) throw new Error('任务服务已关闭') }
  private async file(folder: 'tasks' | 'first-versions', id: string) {
    uuid.parse(id)
    const path = join(this.root, folder, `${id}.json`)
    const info = await this.fs.lstat(path)
    if (info && info.type !== 'file') throw new Error('任务记录必须是普通文件')
    const target = await this.fs.resolve(path)
    if (!this.fs.contains(await this.fs.resolve(join(this.root, folder)), target)) throw new Error('任务记录路径越界')
    return target
  }
  private async read<T>(folder: 'tasks' | 'first-versions', id: string, schema: z.ZodType<T>): Promise<{ value: T; version: FsVersion }> {
    const target = await this.file(folder, id); const before = await this.fs.stat(target)
    if (!before || before.type !== 'file') throw new Error('任务记录不存在')
    const text = new TextDecoder('utf-8', { fatal: true }).decode(await this.fs.readBytes(target, undefined, 1024 * 1024))
    if (parseDocument(text, { uniqueKeys: true }).errors.length) throw new Error('任务记录格式无效')
    const value = schema.parse(JSON.parse(text))
    const after = await this.fs.stat(target)
    if (!after || before.version !== after.version) throw new Error('任务记录读取期间发生变化')
    return { value, version: after.version }
  }
  private async save<T>(folder: 'tasks' | 'first-versions', id: string, value: T, schema: z.ZodType<T>): Promise<{ value: T; version: FsVersion }> {
    const text = `${JSON.stringify(value, null, 2)}\n`
    if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('任务记录超过大小限制')
    const target = await this.file(folder, id)
    const existing = await this.fs.stat(target)
    if (existing) {
      const saved = await this.read(folder, id, schema)
      if (JSON.stringify(saved.value) !== JSON.stringify(value)) throw new Error('操作身份已用于不同记录')
      return saved
    }
    try { return { value, version: (await this.fs.writeText(target, text, { kind: 'createIfAbsent' })).version } }
    catch (error) { throw new Error(`任务记录写入结果不确定：${folder}/${id}.json`, { cause: error }) }
  }
  private async task(id: string) {
    const result = await this.read('tasks', id, taskSchema)
    if (result.value.id !== id || result.value.worldId !== this.world.worldId || result.value.worldBinding !== worldBindingFingerprint(this.world)) throw new Error('任务身份或世界绑定不匹配')
    if (new Set(result.value.sessionIds).size !== result.value.sessionIds.length) throw new Error('任务 Session 身份重复')
    return result
  }
  /** 根据稳定操作 ID 创建或核对完全相同的任务，不创建或更改 Session。 */
  createTask(input: { id: string; sessionIds: readonly string[]; createdAt: string }) {
    this.check()
    return this.gate.run(async () => { if (this.closed) throw new Error('任务服务已关闭')
      const value = taskSchema.parse({ formatVersion: 1, ...input, worldId: this.world.worldId, worldBinding: worldBindingFingerprint(this.world) })
      if (new Set(value.sessionIds).size !== value.sessionIds.length) throw new Error('任务 Session 身份重复')
      return this.save('tasks', value.id, value, taskSchema)
    })
  }
  readTask(id: string) { this.check(); return this.gate.run(() => { if (this.closed) throw new Error('任务服务已关闭'); return this.task(id) }) }

  /** 明确完成判断绑定实际读取的正文版本；缺失、变化或未绑定目标均拒绝。 */
  confirmFirstVersion(input: { id: string; taskId: string; createdAt: string; actor: 'user' | 'trusted-workflow'; scope: string;
    artifacts: readonly { target: DiscussionTarget; version: string }[] }) {
    this.check()
    return this.gate.run(async () => { if (this.closed) throw new Error('任务服务已关闭')
      await this.task(input.taskId)
      const existing = await this.fs.stat(await this.file('first-versions', input.id))
      if (existing) {
        const saved = await this.read('first-versions', input.id, judgmentSchema)
        const storedInput = { id: saved.value.id, taskId: saved.value.taskId, createdAt: saved.value.createdAt, actor: saved.value.actor, scope: saved.value.scope,
          artifacts: saved.value.artifacts.map(item => ({ target: parseDiscussionTarget(item.target), version: item.version })) }
        const request = { id: input.id, taskId: input.taskId, createdAt: input.createdAt, actor: input.actor, scope: input.scope, artifacts: input.artifacts.map(item => ({ target: parseDiscussionTarget(item.target), version: item.version })) }
        if (saved.value.worldId !== this.world.worldId || JSON.stringify(storedInput) !== JSON.stringify(request)) throw new Error('操作身份已用于不同记录')
        return saved
      }
      if (!input.artifacts.length) throw new Error('第一版判断缺少成果')
      const keys = new Set<string>(); const artifacts = []
      for (const item of input.artifacts) {
        const target = parseDiscussionTarget(item.target); const key = JSON.stringify(target)
        if (keys.has(key)) throw new Error('第一版成果重复')
        keys.add(key)
        if (this.adapter.isTargetBoundToWorld?.(target, this.world) !== true) throw new Error('第一版成果未绑定此世界')
        const current = await this.adapter.read(target)
        if (current.version !== item.version) throw new Error('第一版成果版本已变化')
        artifacts.push({ target, version: current.version, digest: sha256(current.content) })
      }
      const value = judgmentSchema.parse({ ...input, artifacts, formatVersion: 1, worldId: this.world.worldId })
      return this.save('first-versions', value.id, value, judgmentSchema)
    })
  }
  /** 只读重启复核：原记录保持不变，每个成果单独返回当前状态。 */
  readFirstVersion(taskId: string, id: string) {
    this.check()
    return this.gate.run(async () => { if (this.closed) throw new Error('任务服务已关闭')
      await this.task(taskId)
      const result = await this.read('first-versions', id, judgmentSchema)
      if (result.value.id !== id || result.value.taskId !== taskId || result.value.worldId !== this.world.worldId) throw new Error('第一版判断身份不匹配')
      const keys = new Set<string>(); const artifacts = []
      for (const item of result.value.artifacts) {
        const target = parseDiscussionTarget(item.target); const key = JSON.stringify(target)
        if (keys.has(key)) throw new Error('第一版成果重复')
        keys.add(key)
        if (this.adapter.isTargetBoundToWorld?.(target, this.world) !== true) throw new Error('第一版成果未绑定此世界')
        try {
          const current = await this.adapter.read(target)
          artifacts.push({ target, status: current.version === item.version && sha256(current.content) === item.digest ? 'current' as const : 'changed' as const })
        } catch (error) { artifacts.push({ target, status: 'unreadable' as const, error: error instanceof Error ? error.message : String(error) }) }
      }
      return { ...result, artifacts }
    })
  }
  close(): Promise<void> {
    if (this.closed) return Promise.resolve()
    if (!this.closing) this.closing = this.gate.run(async () => { this.closed = true; occupied.delete(this.root) })
    return this.closing
  }
  isBoundToWorld(world: WorldWorkspaceConfig): boolean { return sameWorldWorkspace(this.world, world) }
  isBoundToRecovery(world: WorldWorkspaceConfig, gate: WorldAccess): boolean { return this.gate === gate && this.isBoundToWorld(world) }
}
