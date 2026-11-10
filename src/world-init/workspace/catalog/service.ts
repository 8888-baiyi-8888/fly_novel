import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@fly-novel/fs-local'
import type { FsTarget, FsVersion } from '@fly-novel/fs'
import { validateWorldWorkspaceConfigs, type WorldWorkspaceConfig } from '../config.js'
import { formatCatalogDocument, parseCatalogDocument, readCatalog, validateCatalogRelativePath, type CatalogDocument, type CatalogRecord } from './format.js'
import { resolveCatalogTarget } from './path.js'

export type CatalogFileStatus = 'current' | 'stale' | 'missing' | 'unreadable' | 'changing' | 'forbidden'
export interface CatalogItem { record: CatalogRecord; fileStatus: CatalogFileStatus }
export interface CatalogPage { items: CatalogItem[]; total: number; offset: number; nextOffset: number | null; version: string }

/** 目录操作失败的稳定错误码。 */
export class CatalogError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) { super(message, options) }
}

const occupiedWorlds = new Set<string>()
const occupiedRoots = new Set<string>()
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const cancelled = (signal?: AbortSignal) => { if (signal?.aborted) throw new CatalogError('ABORTED', '目录操作已取消', { cause: signal.reason }) }
const code = (error: unknown) => error instanceof Error && 'code' in error ? String(error.code) : ''

/** 可信装配固定的 Agent 能力；调用参数不包含世界或负责人。 */
export interface CatalogBinding {
  register(path: string, summary: string, signal?: AbortSignal): Promise<{ record: CatalogRecord; fileStatus: CatalogFileStatus }>
  update(path: string, summary: string, revision: string, signal?: AbortSignal): Promise<{ record: CatalogRecord; fileStatus: CatalogFileStatus }>
  remove(path: string, revision: string, signal?: AbortSignal): Promise<{ path: string }>
  read(path: string, signal?: AbortSignal): Promise<CatalogItem | undefined>
  search(input?: { ownerAgentId?: string; keyword?: string; offset?: number; limit?: number; version?: string }, signal?: AbortSignal): Promise<CatalogPage>
}

/** 由可信应用持有的单世界目录服务；必须等待 close。 */
export class CatalogService {
  private tail: Promise<void> = Promise.resolve()
  private closed = false
  private closing?: Promise<void>
  private constructor(private readonly world: WorldWorkspaceConfig, private readonly fs: LocalFileSystem,
    private readonly disposeFs: () => Promise<void>, private readonly rootKey: string, private readonly maxCatalogBytes: number) {}

  /** 打开已有目录；同一世界或目录在进程内只能由一个服务打开。 */
  static async open(config: WorldWorkspaceConfig, options: { singleWriterProcess: true; maxCatalogBytes?: number }): Promise<CatalogService> {
    if (options?.singleWriterProcess !== true) throw new CatalogError('CATALOG_FORBIDDEN', '必须确保同一世界仅由一个可信进程写入')
    const maxCatalogBytes = options.maxCatalogBytes ?? 16 * 1024 * 1024
    if (!Number.isSafeInteger(maxCatalogBytes) || maxCatalogBytes < 1) throw new CatalogError('CATALOG_INVALID_INPUT', '目录文件大小上限无效')
    const [world] = await validateWorldWorkspaceConfigs([config])
    if (!world) throw new CatalogError('CATALOG_INVALID_INPUT', '世界配置无效')
    const rootKey = process.platform === 'win32' ? world.catalogRoot.toLowerCase() : world.catalogRoot
    if (occupiedWorlds.has(world.worldId) || occupiedRoots.has(rootKey)) throw new CatalogError('CATALOG_CONFLICT', '世界目录服务正在使用')
    occupiedWorlds.add(world.worldId); occupiedRoots.add(rootKey)
    const context = new Context()
    let scope: ReturnType<Context['plugin']> | undefined
    try {
      await readCatalog(world, maxCatalogBytes)
      scope = context.plugin(LocalFileSystem, { cwd: world.readRoot })
      await scope
      return new CatalogService(world, context.fs as LocalFileSystem, () => scope!.dispose(), rootKey, maxCatalogBytes)
    } catch (error) {
      try { await scope?.dispose() } catch (cleanup) { throw new AggregateError([error, cleanup], '目录服务启动及清理失败') }
      occupiedWorlds.delete(world.worldId); occupiedRoots.delete(rootKey)
      throw error
    }
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new CatalogError('CATALOG_CLOSED', '目录服务已关闭'))
    const result = this.tail.then(action)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }

  /** 绑定可信业务身份；相同服务的绑定共享队列。 */
  bind(agentId: string): CatalogBinding {
    if (this.closed) throw new CatalogError('CATALOG_CLOSED', '目录服务已关闭')
    if (![this.world.mainAgent, ...this.world.agents].some(agent => agent.agentId === agentId)) throw new CatalogError('CATALOG_FORBIDDEN', 'Agent 不属于该世界')
    return Object.freeze({
      register: (path: string, summary: string, signal?: AbortSignal) => this.enqueue(() => this.write('register', agentId, path, summary, undefined, signal)),
      update: (path: string, summary: string, revision: string, signal?: AbortSignal) => this.enqueue(() => this.write('update', agentId, path, summary, revision, signal)),
      remove: (path: string, revision: string, signal?: AbortSignal) => this.enqueue(() => this.remove(agentId, path, revision, signal)),
      read: (path: string, signal?: AbortSignal) => this.enqueue(() => this.read(path, signal)),
      search: (input = {}, signal?: AbortSignal) => this.enqueue(() => this.search(input, signal)),
    })
  }

  private async snapshot(signal?: AbortSignal): Promise<{ doc: CatalogDocument; version: string; target: FsTarget; fsVersion: FsVersion }> {
    cancelled(signal)
    const target = await this.fs.resolve(join(this.world.catalogRoot, 'catalog.json'), { signal })
    const before = await this.fs.stat(target, signal)
    if (!before || before.type !== 'file') throw new CatalogError('CATALOG_INVALID_DOCUMENT', '目录文件不存在或不是普通文件')
    const doc = await readCatalog(this.world, this.maxCatalogBytes)
    const bytes = await this.fs.readBytes(target, signal, this.maxCatalogBytes)
    const after = await this.fs.stat(target, signal)
    if (!after || before.version !== after.version) throw new CatalogError('CATALOG_CONFLICT', '目录读取期间发生变化')
    const parsed = parseCatalogDocument(new TextDecoder('utf-8', { fatal: true }).decode(bytes), this.world.worldId)
    if (JSON.stringify(doc) !== JSON.stringify(parsed)) throw new CatalogError('CATALOG_CONFLICT', '目录读取结果不一致')
    return { doc, version: hash(bytes), target, fsVersion: before.version }
  }

  private async digest(owner: string, path: string, signal?: AbortSignal): Promise<{ path: string; digest: string }> {
    cancelled(signal)
    let resolved: Awaited<ReturnType<typeof resolveCatalogTarget>>
    try { resolved = await resolveCatalogTarget(this.world, owner, path) } catch (error) {
      if (error instanceof Error && /不属于|授权范围|负责人/.test(error.message)) throw new CatalogError('CATALOG_FORBIDDEN', '成果不属于当前 Agent', { cause: error })
      throw error
    }
    const target = await this.fs.resolve(resolved.absolutePath, { signal })
    const before = await this.fs.stat(target, signal)
    if (!before || before.type !== 'file') throw new CatalogError('CATALOG_NOT_FOUND', '成果文件不存在')
    const hasher = createHash('sha256')
    let offset = 0
    for (;;) {
      cancelled(signal)
      const bytes = await this.fs.readByteRange(target, { offset, length: 64 * 1024 }, signal)
      hasher.update(bytes); offset += bytes.length
      if (bytes.length < 64 * 1024) break
    }
    const after = await this.fs.stat(target, signal)
    const again = await resolveCatalogTarget(this.world, owner, path)
    if (!after || after.version !== before.version || again.absolutePath !== resolved.absolutePath) throw new CatalogError('CATALOG_CONFLICT', '成果检查期间变化')
    return { path: resolved.path, digest: hasher.digest('hex') }
  }

  private async status(record: CatalogRecord, signal?: AbortSignal): Promise<CatalogFileStatus> {
    try { return (await this.digest(record.ownerAgentId, record.path, signal)).digest === record.contentSha256 ? 'current' : 'stale' }
    catch (error) {
      if (signal?.aborted) throw error
      if (['ENOENT', 'ENOTDIR', 'FS_NOT_FOUND', 'CATALOG_NOT_FOUND'].includes(code(error))) return 'missing'
      if (code(error) === 'CATALOG_CONFLICT') return 'changing'
      if (code(error) === 'CATALOG_FORBIDDEN') return 'forbidden'
      return 'unreadable'
    }
  }

  private lookup(doc: CatalogDocument, path: string): CatalogRecord | undefined {
    const valid = validateCatalogRelativePath(path)
    const key = process.platform === 'win32' ? valid.toLowerCase() : valid
    return doc.records.find(item => (process.platform === 'win32' ? item.path.toLowerCase() : item.path) === key)
  }

  private async publish(snapshot: Awaited<ReturnType<CatalogService['snapshot']>>, doc: CatalogDocument, signal?: AbortSignal): Promise<void> {
    cancelled(signal)
    try { await this.fs.writeText(snapshot.target, formatCatalogDocument(doc), { kind: 'replaceIfVersion', version: snapshot.fsVersion }, signal) }
    catch (error) {
      if (code(error) === 'FS_STALE_VERSION' || code(error) === 'FS_NOT_OBSERVED') throw new CatalogError('CATALOG_CONFLICT', '目录已变化', { cause: error })
      if (code(error) === 'FS_ABORTED') throw new CatalogError('ABORTED', '目录发布前取消', { cause: error })
      throw new CatalogError('CATALOG_COMMIT_UNKNOWN', '目录发布结果不确定，请重新读取', { cause: error })
    }
  }

  private async write(mode: 'register' | 'update', owner: string, path: string, summary: string, revision?: string, signal?: AbortSignal) {
    if (typeof summary !== 'string' || !summary.trim()) throw new CatalogError('CATALOG_INVALID_INPUT', '简介不能为空')
    const snapshot = await this.snapshot(signal)
    const first = await this.digest(owner, path, signal)
    const existing = this.lookup(snapshot.doc, first.path)
    if (mode === 'register' && existing) throw new CatalogError('CATALOG_CONFLICT', '成果已经登记')
    if (mode === 'update') {
      if (!existing) throw new CatalogError('CATALOG_NOT_FOUND', '目录记录不存在')
      if (existing.ownerAgentId !== owner) throw new CatalogError('CATALOG_FORBIDDEN', '不能修改其他 Agent 的记录')
      if (existing.revision !== revision) throw new CatalogError('CATALOG_CONFLICT', '记录版本已变化')
    }
    const record: CatalogRecord = { path: first.path, ownerAgentId: owner, summary, contentSha256: first.digest, revision: randomUUID() }
    const rechecked = await this.digest(owner, path, signal)
    if (first.path !== rechecked.path || first.digest !== rechecked.digest) throw new CatalogError('CATALOG_CONFLICT', '成果已变化')
    const doc = { ...snapshot.doc, records: [...snapshot.doc.records.filter(item => item !== existing), record] }
    await this.publish(snapshot, doc, signal)
    return { record, fileStatus: await this.status(record) }
  }

  private async remove(owner: string, path: string, revision: string, signal?: AbortSignal): Promise<{ path: string }> {
    const snapshot = await this.snapshot(signal)
    const existing = this.lookup(snapshot.doc, path)
    if (!existing) throw new CatalogError('CATALOG_NOT_FOUND', '目录记录不存在')
    if (existing.ownerAgentId !== owner) throw new CatalogError('CATALOG_FORBIDDEN', '不能删除其他 Agent 的记录')
    if (existing.revision !== revision) throw new CatalogError('CATALOG_CONFLICT', '记录版本已变化')
    await this.publish(snapshot, { ...snapshot.doc, records: snapshot.doc.records.filter(item => item !== existing) }, signal)
    return { path: existing.path }
  }

  private async read(path: string, signal?: AbortSignal): Promise<CatalogItem | undefined> {
    const snapshot = await this.snapshot(signal)
    const record = this.lookup(snapshot.doc, path)
    return record ? { record, fileStatus: await this.status(record, signal) } : undefined
  }

  private async search(input: { ownerAgentId?: string; keyword?: string; offset?: number; limit?: number; version?: string }, signal?: AbortSignal): Promise<CatalogPage> {
    const offset = input.offset ?? 0; const limit = input.limit ?? 50
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (offset > 0 && !input.version)) throw new CatalogError('CATALOG_INVALID_INPUT', '分页参数无效')
    const snapshot = await this.snapshot(signal)
    if (input.version && input.version !== snapshot.version) throw new CatalogError('CATALOG_CONFLICT', '目录版本已变化')
    const records = snapshot.doc.records.filter(record => (input.ownerAgentId === undefined || record.ownerAgentId === input.ownerAgentId) &&
      (input.keyword === undefined || record.summary.includes(input.keyword))).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    const items: CatalogItem[] = []
    for (const record of records.slice(offset, offset + limit)) items.push({ record, fileStatus: await this.status(record, signal) })
    return { items, total: records.length, offset, nextOffset: offset + items.length < records.length ? offset + items.length : null, version: snapshot.version }
  }

  /** 等待已提交操作并释放后端；清理失败保留世界占用。 */
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    return this.closing = (async () => { await this.tail; await this.disposeFs(); occupiedWorlds.delete(this.world.worldId); occupiedRoots.delete(this.rootKey) })()
  }
}
