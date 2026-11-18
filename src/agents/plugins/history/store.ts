import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, join, resolve } from 'node:path'
import type { FileSystem, FsTarget, FsVersion } from '@fly-novel/fs'
import { z } from 'zod'
import { formatHistoryEvent, historyEventSchema, historyIdSchema, parseHistoryEvent, validateHistoryEventGraph, type HistoryEvent } from './format.js'

export type HistoryErrorCode = 'HISTORY_INVALID_CONFIG' | 'HISTORY_BUSY' | 'HISTORY_CLOSED' | 'HISTORY_FORBIDDEN' | 'HISTORY_NOT_FOUND' | 'HISTORY_INVALID_DOCUMENT' | 'HISTORY_CONFLICT' | 'HISTORY_LIMIT' | 'HISTORY_COMMIT_UNKNOWN' | 'HISTORY_REFERENCE_UNAVAILABLE'
export class HistoryError extends Error {
  constructor(message: string, readonly code: HistoryErrorCode, readonly path?: string, options?: ErrorOptions) { super(message, options); this.name = 'HistoryError' }
}
export type HistoryReferenceResolver = (id: string, signal?: AbortSignal) => Promise<{ id: string; worldId: string } | null>
export type HistoryEventInput = Omit<HistoryEvent, 'formatVersion' | 'worldId' | 'id' | 'contentStatus'>
export interface HistoryStoreConfig { fs: FileSystem; root: string; worldId: string; phase: 'initialization'; access: 'read-only' | 'read-write'; singleWriterProcess: true;
  resolvePerson?: HistoryReferenceResolver; resolvePlace?: HistoryReferenceResolver; resolveOrganization?: HistoryReferenceResolver; maxDocumentBytes?: number; maxDocuments?: number }
export interface StoredHistoryEvent { document: HistoryEvent; path: string; version: FsVersion }
export interface HistorySnapshot { events: StoredHistoryEvent[]; version: string }
const candidateSchema = z.object({ formatVersion: z.literal(1), worldId: z.string().trim().min(1), eventId: historyIdSchema, baseline: z.string().min(1), document: historyEventSchema }).strict()
const occupiedWorlds = new Set<string>(); const occupiedRoots = new Set<string>()

/** 单世界初始化历史存储；调用方持有文件后端并确保单可信写入进程。 */
export class HistoryStore {
  private tail: Promise<void> = Promise.resolve(); private closed = false; private closing?: Promise<void>
  private constructor(private readonly config: HistoryStoreConfig, private readonly rootPath: string, private readonly root: FsTarget,
    private readonly maxBytes: number, private readonly maxDocuments: number) {}
  get worldId(): string { return this.config.worldId }
  get rootDirectory(): string { return this.rootPath }
  get writable(): boolean { return this.config.access === 'read-write' }

  /** 打开已有真实根目录及 events、candidates 子目录，不创建或迁移资料。 */
  static async open(config: HistoryStoreConfig): Promise<HistoryStore> {
    if (!config || !config.fs || config.phase !== 'initialization' || config.singleWriterProcess !== true || typeof config.worldId !== 'string' || !config.worldId || config.worldId.trim() !== config.worldId ||
      typeof config.root !== 'string' || !isAbsolute(config.root) || (config.access !== 'read-only' && config.access !== 'read-write') ||
      [config.resolvePerson, config.resolvePlace, config.resolveOrganization].some(value => value !== undefined && typeof value !== 'function')) throw new HistoryError('历史存储配置无效', 'HISTORY_INVALID_CONFIG')
    const maxBytes = config.maxDocumentBytes ?? 1024 * 1024; const maxDocuments = config.maxDocuments ?? 10000
    if (![maxBytes, maxDocuments].every(value => Number.isSafeInteger(value) && value > 0)) throw new HistoryError('历史存储限制无效', 'HISTORY_INVALID_CONFIG')
    const path = resolve(config.root); const target = await config.fs.resolve(path); const info = await config.fs.lstat(path)
    if (!info || info.type !== 'directory' || config.fs.processPath(target) !== path) throw new HistoryError('历史根必须是现有真实目录', 'HISTORY_INVALID_CONFIG')
    if (occupiedWorlds.has(config.worldId) || occupiedRoots.has(target.targetKey)) throw new HistoryError('历史世界或目录正在使用', 'HISTORY_BUSY')
    occupiedWorlds.add(config.worldId); occupiedRoots.add(target.targetKey)
    const store = new HistoryStore({ ...config }, path, target, maxBytes, maxDocuments)
    try { await store.directory('events'); await store.directory('candidates'); return store }
    catch (error) { occupiedWorlds.delete(config.worldId); occupiedRoots.delete(target.targetKey); throw error }
  }
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new HistoryError('历史存储已关闭', 'HISTORY_CLOSED'))
    const result = this.tail.then(fn); this.tail = result.then(() => undefined, () => undefined); return result
  }
  private async directory(name: 'events' | 'candidates'): Promise<FsTarget> {
    const path = join(this.rootPath, name); const info = await this.config.fs.lstat(path)
    if (!info || info.type !== 'directory') throw new HistoryError('历史子目录必须为真实目录', 'HISTORY_INVALID_CONFIG', name)
    const target = await this.config.fs.resolve(path)
    if (!this.config.fs.contains(this.root, target) || this.config.fs.processPath(target) !== path) throw new HistoryError('历史子目录超出授权范围', 'HISTORY_FORBIDDEN', name)
    return target
  }
  private async target(name: 'events' | 'candidates', id: string): Promise<FsTarget> {
    historyIdSchema.parse(id); const path = join(this.rootPath, name, `${id}.json`)
    const root = await this.config.fs.resolve(this.rootPath)
    if (root.targetKey !== this.root.targetKey || (await this.config.fs.lstat(this.rootPath))?.type !== 'directory') throw new HistoryError('历史根目录已变化', 'HISTORY_CONFLICT')
    await this.directory(name); const info = await this.config.fs.lstat(path)
    if (info && info.type !== 'file') throw new HistoryError('历史文档必须是普通文件', 'HISTORY_FORBIDDEN', `${name}/${id}.json`)
    const target = await this.config.fs.resolve(path)
    if (!this.config.fs.contains(this.root, target) || this.config.fs.processPath(target) !== path) throw new HistoryError('历史文档超出授权范围', 'HISTORY_FORBIDDEN', `${name}/${id}.json`)
    return target
  }
  private async bytes(name: 'events' | 'candidates', id: string, signal?: AbortSignal): Promise<{ text: string; path: string; version: FsVersion }> {
    signal?.throwIfAborted(); const path = `${name}/${id}.json`; const target = await this.target(name, id)
    const before = await this.config.fs.stat(target, signal)
    if (!before) throw new HistoryError('历史文档不存在', 'HISTORY_NOT_FOUND', path)
    if (before.type !== 'file') throw new HistoryError('历史文档不是普通文件', 'HISTORY_FORBIDDEN', path)
    const bytes = await this.config.fs.readBytes(target, signal, this.maxBytes); const after = await this.config.fs.stat(target, signal)
    const fresh = await this.target(name, id)
    if (!after || before.version !== after.version || fresh.targetKey !== target.targetKey) throw new HistoryError('历史文档读取期间变化', 'HISTORY_CONFLICT', path)
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch (error) { throw new HistoryError('历史文档编码无效', 'HISTORY_INVALID_DOCUMENT', path, { cause: error }) }
    return { text, path, version: after.version }
  }
  private async read(id: string, signal?: AbortSignal): Promise<StoredHistoryEvent> {
    const file = await this.bytes('events', id, signal); let document: HistoryEvent
    try { document = parseHistoryEvent(file.text) } catch (error) { throw new HistoryError('历史事件损坏、格式或版本无效', 'HISTORY_INVALID_DOCUMENT', file.path, { cause: error }) }
    if (document.id !== id || document.worldId !== this.config.worldId) throw new HistoryError('历史事件身份或世界不匹配', 'HISTORY_INVALID_DOCUMENT', file.path)
    return { document, path: file.path, version: file.version }
  }
  private async scan(signal?: AbortSignal): Promise<HistorySnapshot> {
    const items = await this.config.fs.listDir(await this.directory('events'), signal)
    if (items.length > this.maxDocuments) throw new HistoryError('历史文档数量超过限制', 'HISTORY_LIMIT')
    const events: StoredHistoryEvent[] = []
    for (const item of items) {
      signal?.throwIfAborted(); if (!item.name.endsWith('.json')) continue
      const id = item.name.slice(0, -5)
      if (!historyIdSchema.safeParse(id).success) throw new HistoryError('历史事件文件名无效', 'HISTORY_INVALID_DOCUMENT', `events/${item.name}`)
      events.push(await this.read(id, signal))
    }
    events.sort((a, b) => a.path.localeCompare(b.path))
    try { validateHistoryEventGraph(events.map(value => value.document), this.config.worldId) }
    catch (error) { throw new HistoryError(`历史事件关联无效：${error instanceof Error ? error.message : '未知问题'}`, 'HISTORY_INVALID_DOCUMENT', undefined, { cause: error }) }
    for (const item of events) if ((await this.config.fs.stat(await this.target('events', item.document.id), signal))?.version !== item.version) throw new HistoryError('历史扫描期间文件变化', 'HISTORY_CONFLICT')
    const names = (await this.config.fs.listDir(await this.directory('events'), signal)).filter(value => value.name.endsWith('.json')).map(value => value.name).sort()
    if (JSON.stringify(names) !== JSON.stringify(events.map(value => `${value.document.id}.json`).sort())) throw new HistoryError('历史扫描期间目录变化', 'HISTORY_CONFLICT')
    return { events, version: createHash('sha256').update(JSON.stringify(events)).digest('hex') }
  }
  private resolver(type: 'person' | 'place' | 'organization'): HistoryReferenceResolver | undefined {
    return type === 'person' ? this.config.resolvePerson : type === 'place' ? this.config.resolvePlace : this.config.resolveOrganization
  }
  private async verify(document: HistoryEvent, signal?: AbortSignal): Promise<void> {
    for (const ref of document.references) if (ref.kind === 'linked') {
      const resolver = this.resolver(ref.type)
      if (!resolver) throw new HistoryError('历史引用解析器未装配', 'HISTORY_REFERENCE_UNAVAILABLE')
      signal?.throwIfAborted(); const value = await resolver(ref.id, signal); signal?.throwIfAborted()
      if (!value || value.id !== ref.id || value.worldId !== this.config.worldId) throw new HistoryError('历史引用不存在或世界不匹配', 'HISTORY_INVALID_DOCUMENT')
    }
  }
  private async write(name: 'events' | 'candidates', id: string, content: string, expected: { kind: 'createIfAbsent' } | { kind: 'replaceIfVersion'; version: FsVersion }, signal?: AbortSignal): Promise<FsVersion> {
    const path = `${name}/${id}.json`
    if (!this.writable) throw new HistoryError('历史存储只读', 'HISTORY_FORBIDDEN', path)
    signal?.throwIfAborted(); if (Buffer.byteLength(content) > this.maxBytes) throw new HistoryError('历史文档超过大小限制', 'HISTORY_LIMIT', path)
    const target = await this.target(name, id)
    try { return (await this.config.fs.writeText(target, content, expected, signal)).version }
    catch (error) {
      if (error instanceof Error && 'code' in error && (error.code === 'FS_STALE_VERSION' || error.code === 'FS_NOT_OBSERVED')) throw new HistoryError('历史文档已存在或版本已变化', 'HISTORY_CONFLICT', path, { cause: error })
      if (error instanceof Error && 'code' in error && error.code === 'FS_ABORTED') throw error
      throw new HistoryError('历史文档发布结果不确定，请核查目标', 'HISTORY_COMMIT_UNKNOWN', path, { cause: error })
    }
  }
  private graph(events: HistoryEvent[]): void {
    try { validateHistoryEventGraph(events, this.config.worldId) } catch (error) { throw new HistoryError(`历史事件关联无效：${error instanceof Error ? error.message : '未知问题'}`, 'HISTORY_INVALID_DOCUMENT', undefined, { cause: error }) }
  }
  /** 创建初始化历史方案；关联必须指向当前同世界事件或经可信解析的实体。 */
  create(input: HistoryEventInput, signal?: AbortSignal): Promise<{ id: string; path: string; version: FsVersion }> {
    return this.enqueue(async () => {
      const current = await this.scan(signal); if (current.events.length >= this.maxDocuments) throw new HistoryError('历史文档数量超过限制', 'HISTORY_LIMIT')
      const document = historyEventSchema.parse({ ...input, formatVersion: 1, worldId: this.config.worldId, id: randomUUID(), contentStatus: 'suggested' })
      this.graph([...current.events.map(item => item.document), document]); await this.verify(document, signal)
      return { id: document.id, path: `events/${document.id}.json`, version: await this.write('events', document.id, formatHistoryEvent(document), { kind: 'createIfAbsent' }, signal) }
    })
  }
  /** 按 ID 读取事件及文件版本，校验整个事件图。 */
  readEvent(id: string, signal?: AbortSignal): Promise<StoredHistoryEvent> {
    return this.enqueue(async () => { historyIdSchema.parse(id); const found = (await this.scan(signal)).events.find(item => item.document.id === id); if (!found) throw new HistoryError('历史事件不存在', 'HISTORY_NOT_FOUND'); return found })
  }
  /** 快照覆盖当前事件清单和版本；不是跨进程或跨模块原子快照。 */
  snapshot(signal?: AbortSignal): Promise<HistorySnapshot> { return this.enqueue(() => this.scan(signal)) }
  /** 仅更新未确认事件；已有候选或版本过期时拒绝。 */
  update(id: string, version: string, input: HistoryEventInput, signal?: AbortSignal): Promise<{ path: string; version: FsVersion }> {
    return this.enqueue(async () => {
      historyIdSchema.parse(id); const all = await this.scan(signal); const old = all.events.find(item => item.document.id === id)
      if (!old) throw new HistoryError('历史事件不存在', 'HISTORY_NOT_FOUND')
      if (old.version !== version) throw new HistoryError('历史事件版本已变化', 'HISTORY_CONFLICT', old.path)
      if (old.document.contentStatus !== 'suggested') throw new HistoryError('已确认历史不能直接覆盖', 'HISTORY_FORBIDDEN', old.path)
      if (await this.config.fs.stat(await this.target('candidates', id), signal)) throw new HistoryError('历史事件存在待审候选', 'HISTORY_CONFLICT', `candidates/${id}.json`)
      const document = historyEventSchema.parse({ ...input, formatVersion: 1, worldId: this.config.worldId, id, contentStatus: 'suggested' })
      this.graph(all.events.map(item => item.document.id === id ? document : item.document)); await this.verify(document, signal)
      return { path: old.path, version: await this.write('events', id, formatHistoryEvent(document), { kind: 'replaceIfVersion', version: old.version }, signal) }
    })
  }
  /** 已确认事件创建不覆盖原文的候选；不提供确认或提交入口。 */
  prepare(id: string, version: string, input: HistoryEventInput, signal?: AbortSignal): Promise<{ path: string; version: FsVersion }> {
    return this.enqueue(async () => {
      historyIdSchema.parse(id); const all = await this.scan(signal); const old = all.events.find(item => item.document.id === id)
      if (!old) throw new HistoryError('历史事件不存在', 'HISTORY_NOT_FOUND')
      if (old.version !== version) throw new HistoryError('历史事件版本已变化', 'HISTORY_CONFLICT', old.path)
      if (old.document.contentStatus !== 'confirmed') throw new HistoryError('未确认事件使用初始化更新', 'HISTORY_FORBIDDEN', old.path)
      const document = historyEventSchema.parse({ ...input, formatVersion: 1, worldId: this.config.worldId, id, contentStatus: 'suggested' })
      this.graph(all.events.map(item => item.document.id === id ? document : item.document)); await this.verify(document, signal)
      const candidate = candidateSchema.parse({ formatVersion: 1, worldId: this.config.worldId, eventId: id, baseline: version, document })
      return { path: `candidates/${id}.json`, version: await this.write('candidates', id, `${JSON.stringify(candidate, null, 2)}\n`, { kind: 'createIfAbsent' }, signal) }
    })
  }
  /** 读取候选及其基线；原事件变更时明确报告过期。 */
  readCandidate(id: string, signal?: AbortSignal) {
    return this.enqueue(async () => {
      const current = await this.read(id, signal); const file = await this.bytes('candidates', id, signal); let candidate: z.infer<typeof candidateSchema>
      try { const value: unknown = JSON.parse(file.text); candidate = candidateSchema.parse(value); const { parseDocument } = await import('yaml'); if (parseDocument(file.text, { uniqueKeys: true }).errors.length) throw new Error('重复字段') }
      catch (error) { throw new HistoryError('历史候选损坏或版本无效', 'HISTORY_INVALID_DOCUMENT', file.path, { cause: error }) }
      if (candidate.worldId !== this.config.worldId || candidate.eventId !== id || candidate.document.id !== id || candidate.document.worldId !== this.config.worldId || candidate.document.contentStatus !== 'suggested') throw new HistoryError('历史候选身份无效', 'HISTORY_INVALID_DOCUMENT', file.path)
      return { ...candidate, path: file.path, version: file.version, stale: current.version !== candidate.baseline }
    })
  }
  /** 显式重新核验跨模块引用；缺少解析器、无记录和读取失败不混同。 */
  checkReference(type: 'person' | 'place' | 'organization', id: string, signal?: AbortSignal): Promise<{ status: 'verified' | 'not_found' }> {
    return this.enqueue(async () => {
      historyIdSchema.parse(id); const resolver = this.resolver(type)
      if (!resolver) throw new HistoryError('历史引用解析器未装配', 'HISTORY_REFERENCE_UNAVAILABLE')
      signal?.throwIfAborted(); const found = await resolver(id, signal); signal?.throwIfAborted()
      if (!found) return { status: 'not_found' }
      if (found.id !== id || found.worldId !== this.config.worldId) throw new HistoryError('历史引用身份或世界不匹配', 'HISTORY_INVALID_DOCUMENT')
      return { status: 'verified' }
    })
  }
  close(): Promise<void> {
    if (!this.closing) { this.closed = true; this.closing = this.tail.then(() => { occupiedWorlds.delete(this.config.worldId); occupiedRoots.delete(this.root.targetKey) }) }
    return this.closing
  }
}
