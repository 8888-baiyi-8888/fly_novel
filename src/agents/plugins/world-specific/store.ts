import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, join, resolve } from 'node:path'
import type { FileSystem, FsTarget, FsVersion } from '@fly-novel/fs'
import { z } from 'zod'
import { parseSpecificJson, specificContentSchema, specificDocumentSchema, specificIdSchema, specificKindSchema, type SpecificContent, type SpecificDocument, type SpecificKind } from './format.js'

const folders: Record<SpecificKind, string> = { topic: 'topics', item: 'items' }
const candidateSchema = z.object({ formatVersion: z.literal(1), worldId: z.string().trim().min(1), id: specificIdSchema, kind: specificKindSchema, baseline: z.string().min(1), document: specificDocumentSchema }).strict()
export class SpecificError extends Error { constructor(message: string, readonly code: string, readonly path?: string, options?: ErrorOptions) { super(message, options); this.name = 'SpecificError' } }
export type SpecificResolver = (type: string, id: string, signal?: AbortSignal) => Promise<{ id: string; worldId: string; version?: string } | null | undefined>
export interface SpecificStoreConfig { fs: FileSystem; root: string; worldId: string; phase: 'initialization'; access: 'read-only' | 'read-write'; singleWriterProcess: true; resolveReference?: SpecificResolver; maxDocumentBytes?: number; maxDocuments?: number }
export interface StoredSpecific { document: SpecificDocument; path: string; version: FsVersion }
export interface SpecificSnapshot { items: StoredSpecific[]; version: string }
const worlds = new Set<string>(); const roots = new Set<string>()

/** 世界专有内容初始化存储；由可信调用方持有后端并保证单进程写入。 */
export class SpecificStore {
  private tail: Promise<void> = Promise.resolve(); private closed = false; private closing?: Promise<void>
  private constructor(private readonly config: SpecificStoreConfig, private readonly rootPath: string, private readonly root: FsTarget, private readonly maxBytes: number, private readonly maxDocuments: number) {}
  get worldId() { return this.config.worldId }
  get rootDirectory() { return this.rootPath }
  get writable() { return this.config.access === 'read-write' }
  static async open(config: SpecificStoreConfig): Promise<SpecificStore> {
    if (!config?.fs || config.phase !== 'initialization' || config.singleWriterProcess !== true || typeof config.worldId !== 'string' || !config.worldId || config.worldId.trim() !== config.worldId || typeof config.root !== 'string' || !isAbsolute(config.root) || !['read-only', 'read-write'].includes(config.access) || (config.resolveReference !== undefined && typeof config.resolveReference !== 'function')) throw new SpecificError('专有内容存储配置无效', 'SPECIFIC_INVALID_CONFIG')
    const maxBytes = config.maxDocumentBytes ?? 1048576; const maxDocuments = config.maxDocuments ?? 10000
    if (![maxBytes, maxDocuments].every(value => Number.isSafeInteger(value) && value > 0)) throw new SpecificError('专有内容存储限制无效', 'SPECIFIC_INVALID_CONFIG')
    const path = resolve(config.root); const root = await config.fs.resolve(path); const info = await config.fs.lstat(path)
    if (!info || info.type !== 'directory' || config.fs.processPath(root) !== path) throw new SpecificError('专有内容根须为现有真实目录', 'SPECIFIC_INVALID_CONFIG')
    if (worlds.has(config.worldId) || roots.has(root.targetKey)) throw new SpecificError('专有内容世界或目录正在使用', 'SPECIFIC_BUSY')
    worlds.add(config.worldId); roots.add(root.targetKey)
    const store = new SpecificStore({ ...config }, path, root, maxBytes, maxDocuments)
    try { for (const folder of ['topics', 'items', 'candidates']) await store.directory(folder); return store }
    catch (error) { worlds.delete(config.worldId); roots.delete(root.targetKey); throw error }
  }
  private enqueue<T>(fn: () => Promise<T>): Promise<T> { if (this.closed) return Promise.reject(new SpecificError('专有内容存储已关闭', 'SPECIFIC_CLOSED')); const result = this.tail.then(fn); this.tail = result.then(() => undefined, () => undefined); return result }
  private async directory(folder: string): Promise<FsTarget> {
    const path = join(this.rootPath, folder); const info = await this.config.fs.lstat(path); const target = await this.config.fs.resolve(path)
    if (!info || info.type !== 'directory' || !this.config.fs.contains(this.root, target) || this.config.fs.processPath(target) !== path) throw new SpecificError('专有内容目录无效或越界', 'SPECIFIC_FORBIDDEN', folder)
    return target
  }
  private path(folder: string, id: string) { return `${folder}/${id}.json` }
  private async target(folder: string, id: string): Promise<FsTarget> {
    specificIdSchema.parse(id); const path = join(this.rootPath, folder, `${id}.json`); const root = await this.config.fs.resolve(this.rootPath)
    if (root.targetKey !== this.root.targetKey || (await this.config.fs.lstat(this.rootPath))?.type !== 'directory') throw new SpecificError('专有内容根已变化', 'SPECIFIC_CONFLICT')
    await this.directory(folder); const info = await this.config.fs.lstat(path)
    if (info && info.type !== 'file') throw new SpecificError('专有内容文档不是普通文件', 'SPECIFIC_FORBIDDEN', this.path(folder, id))
    const target = await this.config.fs.resolve(path)
    if (!this.config.fs.contains(this.root, target) || this.config.fs.processPath(target) !== path) throw new SpecificError('专有内容路径越界', 'SPECIFIC_FORBIDDEN')
    return target
  }
  private async bytes(folder: string, id: string, signal?: AbortSignal) {
    signal?.throwIfAborted(); const path = this.path(folder, id); const target = await this.target(folder, id); const before = await this.config.fs.stat(target, signal)
    if (!before) throw new SpecificError('专有内容不存在', 'SPECIFIC_NOT_FOUND', path)
    const bytes = await this.config.fs.readBytes(target, signal, this.maxBytes); const after = await this.config.fs.stat(target, signal); const fresh = await this.target(folder, id)
    if (!after || before.version !== after.version || fresh.targetKey !== target.targetKey) throw new SpecificError('专有内容读取期间变化', 'SPECIFIC_CONFLICT', path)
    let text: string; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch (error) { throw new SpecificError('专有内容编码无效', 'SPECIFIC_INVALID_DOCUMENT', path, { cause: error }) }
    return { text, path, version: after.version }
  }
  private async read(kind: SpecificKind, id: string, signal?: AbortSignal): Promise<StoredSpecific> {
    const file = await this.bytes(folders[kind], id, signal); let document: SpecificDocument
    try { document = parseSpecificJson(file.text, specificDocumentSchema) } catch (error) { throw new SpecificError('专有内容损坏或格式无效', 'SPECIFIC_INVALID_DOCUMENT', file.path, { cause: error }) }
    if (document.worldId !== this.worldId || document.kind !== kind || document.id !== id) throw new SpecificError('专有内容身份或世界不匹配', 'SPECIFIC_INVALID_DOCUMENT', file.path)
    return { document, path: file.path, version: file.version }
  }
  private graph(docs: SpecificDocument[]) {
    const ids = new Set<string>(); for (const doc of docs) { if (doc.worldId !== this.worldId || ids.has(doc.id)) throw new SpecificError('专有内容 ID 重复或世界不符', 'SPECIFIC_INVALID_DOCUMENT'); ids.add(doc.id) }
    for (const doc of docs) {
      for (const id of doc.topicIds) if (!docs.some(other => other.kind === 'topic' && other.id === id)) throw new SpecificError('主题归属不存在', 'SPECIFIC_INVALID_DOCUMENT')
      for (const link of doc.links) if (!docs.some(other => other.kind === link.kind && other.id === link.id)) throw new SpecificError('专有内容关联不存在或类型不符', 'SPECIFIC_INVALID_DOCUMENT')
    }
  }
  private async scan(signal?: AbortSignal): Promise<SpecificSnapshot> {
    const items: StoredSpecific[] = []
    for (const kind of specificKindSchema.options) {
      const folder = folders[kind]; const entries = await this.config.fs.listDir(await this.directory(folder), signal)
      if (entries.length > this.maxDocuments || items.length + entries.length > this.maxDocuments) throw new SpecificError('专有内容数量超过限制', 'SPECIFIC_LIMIT')
      for (const entry of entries) if (entry.name.endsWith('.json')) { const id = entry.name.slice(0, -5); if (!specificIdSchema.safeParse(id).success) throw new SpecificError('专有内容文件名无效', 'SPECIFIC_INVALID_DOCUMENT', `${folder}/${entry.name}`); items.push(await this.read(kind, id, signal)) }
    }
    items.sort((a, b) => a.path.localeCompare(b.path)); this.graph(items.map(value => value.document))
    for (const item of items) if ((await this.config.fs.stat(await this.target(folders[item.document.kind], item.document.id), signal))?.version !== item.version) throw new SpecificError('专有内容扫描期间变化', 'SPECIFIC_CONFLICT')
    for (const kind of specificKindSchema.options) {
      const names = (await this.config.fs.listDir(await this.directory(folders[kind]), signal)).filter(value => value.name.endsWith('.json')).map(value => value.name).sort()
      if (JSON.stringify(names) !== JSON.stringify(items.filter(item => item.document.kind === kind).map(item => `${item.document.id}.json`).sort())) throw new SpecificError('专有内容目录扫描期间变化', 'SPECIFIC_CONFLICT')
    }
    return { items, version: createHash('sha256').update(JSON.stringify(items)).digest('hex') }
  }
  private async verify(doc: SpecificDocument, signal?: AbortSignal) {
    for (const ref of doc.references) if (ref.kind === 'linked') {
      if (!this.config.resolveReference) throw new SpecificError('引用解析器未配置', 'SPECIFIC_REFERENCE_UNAVAILABLE')
      signal?.throwIfAborted(); const found = await this.config.resolveReference(ref.type, ref.id, signal); signal?.throwIfAborted()
      if (found === undefined) throw new SpecificError('该类引用解析器未配置', 'SPECIFIC_REFERENCE_UNAVAILABLE')
      if (!found || found.id !== ref.id || found.worldId !== this.worldId) throw new SpecificError('引用不存在或世界不匹配', 'SPECIFIC_INVALID_DOCUMENT')
    }
  }
  private async write(folder: string, id: string, value: unknown, expected: { kind: 'createIfAbsent' } | { kind: 'replaceIfVersion'; version: FsVersion }, signal?: AbortSignal): Promise<FsVersion> {
    const path = this.path(folder, id); if (!this.writable) throw new SpecificError('专有内容存储只读', 'SPECIFIC_FORBIDDEN', path)
    signal?.throwIfAborted(); const text = `${JSON.stringify(value, null, 2)}\n`; if (Buffer.byteLength(text) > this.maxBytes) throw new SpecificError('专有内容超过大小限制', 'SPECIFIC_LIMIT', path)
    const target = await this.target(folder, id)
    try { return (await this.config.fs.writeText(target, text, expected, signal)).version }
    catch (error) {
      if (error instanceof Error && 'code' in error && (error.code === 'FS_STALE_VERSION' || error.code === 'FS_NOT_OBSERVED')) throw new SpecificError('文件已存在或版本变化', 'SPECIFIC_CONFLICT', path, { cause: error })
      if (error instanceof Error && 'code' in error && error.code === 'FS_ABORTED') throw error
      throw new SpecificError('发布结果不确定，请核查目标', 'SPECIFIC_COMMIT_UNKNOWN', path, { cause: error })
    }
  }
  /** 创建待审主题或内容项；关联目标须已存在。 */
  create(kind: SpecificKind, input: SpecificContent, signal?: AbortSignal) { return this.enqueue(async () => {
    specificKindSchema.parse(kind); const snapshot = await this.scan(signal); if (snapshot.items.length >= this.maxDocuments) throw new SpecificError('专有内容数量超限', 'SPECIFIC_LIMIT')
    const doc = specificDocumentSchema.parse({ ...specificContentSchema.parse(input), formatVersion: 1, worldId: this.worldId, id: randomUUID(), kind, contentStatus: 'suggested' })
    this.graph([...snapshot.items.map(value => value.document), doc]); await this.verify(doc, signal)
    return { id: doc.id, path: this.path(folders[kind], doc.id), version: await this.write(folders[kind], doc.id, doc, { kind: 'createIfAbsent' }, signal) }
  }) }
  readDocument(kind: SpecificKind, id: string, signal?: AbortSignal) { return this.enqueue(async () => { specificKindSchema.parse(kind); specificIdSchema.parse(id); const found = (await this.scan(signal)).items.find(value => value.document.kind === kind && value.document.id === id); if (!found) throw new SpecificError('专有内容不存在', 'SPECIFIC_NOT_FOUND'); return found }) }
  /** 校验已有专有内容候选、主题关联与外部引用，不写入当前资料。 */
  validateCandidate(value: SpecificDocument, signal?: AbortSignal): Promise<void> { return this.enqueue(async () => {
    const doc = specificDocumentSchema.parse(value)
    if (doc.worldId !== this.worldId || doc.contentStatus !== 'suggested') throw new SpecificError('专有内容候选身份或状态无效', 'SPECIFIC_INVALID_DOCUMENT')
    const snapshot = await this.scan(signal)
    if (!snapshot.items.some(item => item.document.id === doc.id && item.document.kind === doc.kind)) throw new SpecificError('专有内容不存在', 'SPECIFIC_NOT_FOUND')
    this.graph(snapshot.items.map(item => item.document.id === doc.id ? doc : item.document)); await this.verify(doc, signal)
  }) }
  snapshot(signal?: AbortSignal) { return this.enqueue(() => this.scan(signal)) }
  update(kind: SpecificKind, id: string, version: string, input: SpecificContent, signal?: AbortSignal) { return this.enqueue(async () => {
    specificKindSchema.parse(kind); specificIdSchema.parse(id); const snapshot = await this.scan(signal); const old = snapshot.items.find(value => value.document.kind === kind && value.document.id === id)
    if (!old) throw new SpecificError('专有内容不存在', 'SPECIFIC_NOT_FOUND'); if (old.version !== version) throw new SpecificError('专有内容版本变化', 'SPECIFIC_CONFLICT')
    if (old.document.contentStatus !== 'suggested') throw new SpecificError('已确认内容不能覆盖', 'SPECIFIC_FORBIDDEN')
    if (await this.config.fs.stat(await this.target('candidates', id), signal)) throw new SpecificError('已有待审候选', 'SPECIFIC_CONFLICT')
    const doc = specificDocumentSchema.parse({ ...specificContentSchema.parse(input), formatVersion: 1, worldId: this.worldId, id, kind, contentStatus: 'suggested' })
    this.graph(snapshot.items.map(value => value.document.id === id ? doc : value.document)); await this.verify(doc, signal)
    return { path: old.path, version: await this.write(folders[kind], id, doc, { kind: 'replaceIfVersion', version: old.version }, signal) }
  }) }
  prepare(kind: SpecificKind, id: string, version: string, input: SpecificContent, signal?: AbortSignal) { return this.enqueue(async () => {
    specificKindSchema.parse(kind); specificIdSchema.parse(id); const snapshot = await this.scan(signal); const old = snapshot.items.find(value => value.document.kind === kind && value.document.id === id)
    if (!old) throw new SpecificError('专有内容不存在', 'SPECIFIC_NOT_FOUND'); if (old.version !== version) throw new SpecificError('专有内容版本变化', 'SPECIFIC_CONFLICT')
    if (old.document.contentStatus !== 'confirmed') throw new SpecificError('未确认内容使用直接更新', 'SPECIFIC_FORBIDDEN')
    const document = specificDocumentSchema.parse({ ...specificContentSchema.parse(input), formatVersion: 1, worldId: this.worldId, id, kind, contentStatus: 'suggested' }); this.graph(snapshot.items.map(value => value.document.id === id ? document : value.document)); await this.verify(document, signal)
    const candidate = candidateSchema.parse({ formatVersion: 1, worldId: this.worldId, id, kind, baseline: version, document })
    return { path: this.path('candidates', id), version: await this.write('candidates', id, candidate, { kind: 'createIfAbsent' }, signal) }
  }) }
  readCandidate(kind: SpecificKind, id: string, signal?: AbortSignal) { return this.enqueue(async () => {
    specificKindSchema.parse(kind); const old = await this.read(kind, id, signal); const file = await this.bytes('candidates', id, signal); let candidate: z.infer<typeof candidateSchema>
    try { candidate = parseSpecificJson(file.text, candidateSchema) } catch (error) { throw new SpecificError('候选损坏或格式无效', 'SPECIFIC_INVALID_DOCUMENT', file.path, { cause: error }) }
    if (candidate.id !== id || candidate.kind !== kind || candidate.worldId !== this.worldId || candidate.document.id !== id || candidate.document.kind !== kind || candidate.document.worldId !== this.worldId || candidate.document.contentStatus !== 'suggested') throw new SpecificError('候选身份不匹配', 'SPECIFIC_INVALID_DOCUMENT', file.path)
    return { candidate, path: file.path, version: file.version, stale: candidate.baseline !== old.version }
  }) }
  checkReference(type: string, id: string, observedVersion: string | null, signal?: AbortSignal) { return this.enqueue(async () => {
    specificIdSchema.parse(id); if (!this.config.resolveReference) return { status: 'unconfigured' as const }
    signal?.throwIfAborted(); const found = await this.config.resolveReference(type, id, signal); signal?.throwIfAborted()
    if (found === undefined) return { status: 'unconfigured' as const }; if (!found) return { status: 'not_found' as const }
    if (found.id !== id || found.worldId !== this.worldId) throw new SpecificError('引用身份或世界不匹配', 'SPECIFIC_INVALID_DOCUMENT')
    if (!observedVersion || !found.version) return { status: 'version_unknown' as const }
    return { status: found.version === observedVersion ? 'current' as const : 'changed' as const }
  }) }
  close(): Promise<void> { if (!this.closing) { this.closed = true; this.closing = this.tail.then(() => { worlds.delete(this.worldId); roots.delete(this.root.targetKey) }) } return this.closing }
}
