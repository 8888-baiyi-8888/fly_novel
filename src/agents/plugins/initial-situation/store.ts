import { randomUUID } from 'node:crypto'
import { isAbsolute, join, resolve } from 'node:path'
import type { FileSystem, FsTarget, FsVersion } from '@fly-novel/fs'
import { z } from 'zod'
import { overviewSchema, parseJson, situationIdSchema, situationSchema, startSchema, type Overview, type Situation, type Start } from './format.js'

type Folder = 'overviews' | 'situations' | 'candidates'
type Kind = 'overview' | 'situation'
type Doc = Overview | Situation
type Stored<T> = { document: T; path: string; version: FsVersion }
export type OverviewInput = Omit<Overview, 'formatVersion' | 'worldId' | 'id' | 'contentStatus'>
export type SituationInput = Omit<Situation, 'formatVersion' | 'worldId' | 'id' | 'contentStatus'>
export type SituationReferenceResolver = (type: string, id: string, signal?: AbortSignal) => Promise<{ id: string; worldId: string; version?: string } | null | undefined>
export interface SituationStoreConfig { fs: FileSystem; root: string; worldId: string; phase: 'initialization'; access: 'read-only' | 'read-write'; singleWriterProcess: true; resolveReference?: SituationReferenceResolver; maxDocumentBytes?: number; maxDocuments?: number }
export class SituationError extends Error {
  constructor(message: string, readonly code: string, readonly path?: string, options?: ErrorOptions) { super(message, options); this.name = 'SituationError' }
}
const candidateSchema = z.object({ formatVersion: z.literal(1), worldId: z.string().trim().min(1), kind: z.enum(['overview', 'situation']), id: situationIdSchema, baseline: z.string().min(1), document: z.union([overviewSchema, situationSchema]) }).strict()
const worlds = new Set<string>(); const roots = new Set<string>()

/** 初始化局势文件存储；调用方管理文件后端并保证单可信写入进程。 */
export class SituationStore {
  private tail: Promise<void> = Promise.resolve(); private closed = false; private closing?: Promise<void>
  private constructor(private readonly config: SituationStoreConfig, private readonly rootPath: string, private readonly root: FsTarget, private readonly maxBytes: number, private readonly maxDocuments: number) {}
  get worldId() { return this.config.worldId }
  get rootDirectory() { return this.rootPath }
  get writable() { return this.config.access === 'read-write' }
  static async open(config: SituationStoreConfig): Promise<SituationStore> {
    if (!config?.fs || config.phase !== 'initialization' || config.singleWriterProcess !== true || !config.worldId || config.worldId.trim() !== config.worldId || !isAbsolute(config.root) || !['read-only', 'read-write'].includes(config.access)) throw new SituationError('局势存储配置无效', 'SITUATION_INVALID_CONFIG')
    const maxBytes = config.maxDocumentBytes ?? 1048576; const maxDocuments = config.maxDocuments ?? 10000
    if (![maxBytes, maxDocuments].every(value => Number.isSafeInteger(value) && value > 0)) throw new SituationError('局势存储限制无效', 'SITUATION_INVALID_CONFIG')
    const path = resolve(config.root); const target = await config.fs.resolve(path); const info = await config.fs.lstat(path)
    if (!info || info.type !== 'directory' || config.fs.processPath(target) !== path) throw new SituationError('局势根必须是现有真实目录', 'SITUATION_INVALID_CONFIG')
    if (worlds.has(config.worldId) || roots.has(target.targetKey)) throw new SituationError('局势世界或目录正在使用', 'SITUATION_BUSY')
    worlds.add(config.worldId); roots.add(target.targetKey)
    const store = new SituationStore({ ...config }, path, target, maxBytes, maxDocuments)
    try { for (const folder of ['overviews', 'situations', 'candidates'] as const) await store.directory(folder); return store }
    catch (error) { worlds.delete(config.worldId); roots.delete(target.targetKey); throw error }
  }
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new SituationError('局势存储已关闭', 'SITUATION_CLOSED'))
    const result = this.tail.then(fn); this.tail = result.then(() => undefined, () => undefined); return result
  }
  private async directory(name: Folder): Promise<FsTarget> {
    const path = join(this.rootPath, name); const info = await this.config.fs.lstat(path); const target = await this.config.fs.resolve(path)
    if (!info || info.type !== 'directory' || !this.config.fs.contains(this.root, target) || this.config.fs.processPath(target) !== path) throw new SituationError('局势目录无效或超出授权范围', 'SITUATION_FORBIDDEN', name)
    return target
  }
  private async target(folder: Folder | 'root', id: string): Promise<FsTarget> {
    if (folder !== 'root') situationIdSchema.parse(id)
    else if (id !== 'start') throw new SituationError('起点文件无效', 'SITUATION_INVALID_DOCUMENT')
    const path = folder === 'root' ? join(this.rootPath, 'start.json') : join(this.rootPath, folder, `${id}.json`)
    const currentRoot = await this.config.fs.resolve(this.rootPath)
    if (currentRoot.targetKey !== this.root.targetKey || (await this.config.fs.lstat(this.rootPath))?.type !== 'directory') throw new SituationError('局势根目录已变化', 'SITUATION_CONFLICT')
    if (folder !== 'root') await this.directory(folder)
    const info = await this.config.fs.lstat(path); if (info && info.type !== 'file') throw new SituationError('局势文档必须是普通文件', 'SITUATION_FORBIDDEN')
    const target = await this.config.fs.resolve(path)
    if (!this.config.fs.contains(this.root, target) || this.config.fs.processPath(target) !== path) throw new SituationError('局势文档超出授权范围', 'SITUATION_FORBIDDEN')
    return target
  }
  private path(folder: Folder | 'root', id: string) { return folder === 'root' ? 'start.json' : `${folder}/${id}.json` }
  private async bytes(folder: Folder | 'root', id: string, signal?: AbortSignal) {
    signal?.throwIfAborted(); const path = this.path(folder, id); const target = await this.target(folder, id); const before = await this.config.fs.stat(target, signal)
    if (!before) throw new SituationError('局势文档不存在', 'SITUATION_NOT_FOUND', path)
    const bytes = await this.config.fs.readBytes(target, signal, this.maxBytes); const after = await this.config.fs.stat(target, signal); const fresh = await this.target(folder, id)
    if (!after || before.version !== after.version || target.targetKey !== fresh.targetKey) throw new SituationError('局势文档读取期间变化', 'SITUATION_CONFLICT', path)
    let text: string; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch (error) { throw new SituationError('局势编码无效', 'SITUATION_INVALID_DOCUMENT', path, { cause: error }) }
    return { text, path, version: after.version }
  }
  private async read<T>(folder: Folder | 'root', id: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<Stored<T>> {
    const file = await this.bytes(folder, id, signal); let document: T
    try { document = parseJson(file.text, schema) } catch (error) { throw new SituationError('局势文档损坏或版本无效', 'SITUATION_INVALID_DOCUMENT', file.path, { cause: error }) }
    if (typeof document !== 'object' || !document || !('worldId' in document) || document.worldId !== this.worldId || (folder !== 'root' && (!('id' in document) || document.id !== id))) throw new SituationError('局势文档身份或世界不匹配', 'SITUATION_INVALID_DOCUMENT', file.path)
    return { document, path: file.path, version: file.version }
  }
  private async write(folder: Folder | 'root', id: string, value: unknown, expected: { kind: 'createIfAbsent' } | { kind: 'replaceIfVersion'; version: FsVersion }, signal?: AbortSignal): Promise<FsVersion> {
    const path = this.path(folder, id); if (!this.writable) throw new SituationError('局势存储只读', 'SITUATION_FORBIDDEN', path)
    signal?.throwIfAborted(); const text = `${JSON.stringify(value, null, 2)}\n`
    if (Buffer.byteLength(text) > this.maxBytes) throw new SituationError('局势文档过大', 'SITUATION_LIMIT', path)
    const target = await this.target(folder, id)
    try { return (await this.config.fs.writeText(target, text, expected, signal)).version }
    catch (error) {
      if (error instanceof Error && 'code' in error && (error.code === 'FS_STALE_VERSION' || error.code === 'FS_NOT_OBSERVED')) throw new SituationError('局势文件已存在或版本已变化', 'SITUATION_CONFLICT', path, { cause: error })
      if (error instanceof Error && 'code' in error && error.code === 'FS_ABORTED') throw error
      throw new SituationError('局势发布结果不确定，请核查文件', 'SITUATION_COMMIT_UNKNOWN', path, { cause: error })
    }
  }
  private async checkReferences(doc: Situation, signal?: AbortSignal) {
    for (const ref of doc.references) if (ref.kind === 'linked') {
      if (!this.config.resolveReference) throw new SituationError('引用解析器未装配', 'SITUATION_REFERENCE_UNAVAILABLE')
      const found = await this.config.resolveReference(ref.type, ref.id, signal); signal?.throwIfAborted()
      if (found === undefined) throw new SituationError('引用解析器未装配', 'SITUATION_REFERENCE_UNAVAILABLE')
      if (!found || found.id !== ref.id || found.worldId !== this.worldId) throw new SituationError('引用不存在或世界不匹配', 'SITUATION_INVALID_DOCUMENT')
    }
  }
  private async list<T extends Doc>(folder: 'overviews' | 'situations', schema: z.ZodType<T>, signal?: AbortSignal): Promise<Stored<T>[]> {
    const entries = await this.config.fs.listDir(await this.directory(folder), signal)
    if (entries.length > this.maxDocuments) throw new SituationError('局势文档数量超过限制', 'SITUATION_LIMIT')
    const result: Stored<T>[] = []
    for (const entry of entries) if (entry.name.endsWith('.json')) { const id = entry.name.slice(0, -5); if (!situationIdSchema.safeParse(id).success) throw new SituationError('局势文件名无效', 'SITUATION_INVALID_DOCUMENT'); result.push(await this.read(folder, id, schema, signal)) }
    for (const item of result) if ((await this.config.fs.stat(await this.target(folder, item.document.id), signal))?.version !== item.version) throw new SituationError('局势扫描期间变化', 'SITUATION_CONFLICT')
    const names = (await this.config.fs.listDir(await this.directory(folder), signal)).filter(item => item.name.endsWith('.json')).map(item => item.name).sort()
    if (JSON.stringify(names) !== JSON.stringify(result.map(item => `${item.document.id}.json`).sort())) throw new SituationError('局势目录扫描期间变化', 'SITUATION_CONFLICT')
    return result
  }
  createStart(description: string, signal?: AbortSignal) { return this.enqueue(async () => { const doc = startSchema.parse({ formatVersion: 1, worldId: this.worldId, description }); return { path: 'start.json', version: await this.write('root', 'start', doc, { kind: 'createIfAbsent' }, signal) } }) }
  readStart(signal?: AbortSignal): Promise<Stored<Start>> { return this.enqueue(() => this.read('root', 'start', startSchema, signal)) }
  /** 修改起点说明前调用方应核查相对起点的已有资料；本方法不自动换算历史。 */
  updateStart(version: string, description: string, signal?: AbortSignal) { return this.enqueue(async () => {
    const current = await this.read('root', 'start', startSchema, signal)
    if (current.version !== version) throw new SituationError('起点版本已变化', 'SITUATION_CONFLICT')
    const doc = startSchema.parse({ formatVersion: 1, worldId: this.worldId, description })
    return { path: current.path, version: await this.write('root', 'start', doc, { kind: 'replaceIfVersion', version: current.version }, signal) }
  }) }
  createOverview(input: OverviewInput, signal?: AbortSignal) { return this.enqueue(async () => {
    await this.read('root', 'start', startSchema, signal); if ((await this.list('overviews', overviewSchema, signal)).length >= this.maxDocuments) throw new SituationError('方案数量超过限制', 'SITUATION_LIMIT')
    const doc = overviewSchema.parse({ ...input, formatVersion: 1, worldId: this.worldId, id: randomUUID(), contentStatus: 'suggested' })
    return { id: doc.id, path: this.path('overviews', doc.id), version: await this.write('overviews', doc.id, doc, { kind: 'createIfAbsent' }, signal) }
  }) }
  readOverview(id: string, signal?: AbortSignal): Promise<Stored<Overview>> { return this.enqueue(() => this.read('overviews', id, overviewSchema, signal)) }
  createSituation(input: SituationInput, signal?: AbortSignal) { return this.enqueue(async () => {
    await this.read('overviews', input.overviewId, overviewSchema, signal)
    const all = await this.list('situations', situationSchema, signal); if (all.length >= this.maxDocuments) throw new SituationError('局势数量超过限制', 'SITUATION_LIMIT')
    const doc = situationSchema.parse({ ...input, formatVersion: 1, worldId: this.worldId, id: randomUUID(), contentStatus: 'suggested' })
    this.checkRelations(doc, all.map(item => item.document)); await this.checkReferences(doc, signal)
    return { id: doc.id, path: this.path('situations', doc.id), version: await this.write('situations', doc.id, doc, { kind: 'createIfAbsent' }, signal) }
  }) }
  private checkRelations(doc: Situation, all: Situation[]) {
    for (const rel of doc.relations) if (!all.some(item => item.id === rel.targetId && item.overviewId === doc.overviewId)) throw new SituationError('局势关联目标不存在或不属于同一方案', 'SITUATION_INVALID_DOCUMENT')
  }
  readSituation(id: string, signal?: AbortSignal): Promise<Stored<Situation>> { return this.enqueue(() => this.read('situations', id, situationSchema, signal)) }
  snapshot(signal?: AbortSignal) { return this.enqueue(async () => ({ overviews: await this.list('overviews', overviewSchema, signal), situations: await this.list('situations', situationSchema, signal) })) }
  /** 重新核验已授权引用；读取失败由解析器抛出，不等同于未找到。 */
  checkReference(type: string, id: string, observedVersion: string | null, signal?: AbortSignal) { return this.enqueue(async () => {
    situationIdSchema.parse(id)
    if (!this.config.resolveReference) return { status: 'unconfigured' as const }
    signal?.throwIfAborted(); const found = await this.config.resolveReference(type, id, signal); signal?.throwIfAborted()
    if (found === undefined) return { status: 'unconfigured' as const }
    if (!found) return { status: 'not_found' as const }
    if (found.worldId !== this.worldId || found.id !== id) throw new SituationError('引用身份或世界不匹配', 'SITUATION_INVALID_DOCUMENT')
    if (!observedVersion || !found.version) return { status: 'version_unknown' as const }
    return { status: found.version === observedVersion ? 'current' as const : 'changed' as const }
  }) }
  private folder(kind: Kind): 'overviews' | 'situations' { return kind === 'overview' ? 'overviews' : 'situations' }
  private async readDoc(kind: Kind, id: string, signal?: AbortSignal): Promise<Stored<Doc>> { return kind === 'overview' ? this.read('overviews', id, overviewSchema, signal) : this.read('situations', id, situationSchema, signal) }
  private async makeDoc(kind: Kind, id: string, input: OverviewInput | SituationInput, old: Doc, signal?: AbortSignal): Promise<Doc> {
    const value = { ...input, formatVersion: 1, worldId: this.worldId, id, contentStatus: 'suggested' }
    if (kind === 'overview') return overviewSchema.parse(value)
    const doc = situationSchema.parse(value); if (!('overviewId' in old) || doc.overviewId !== old.overviewId) throw new SituationError('不能把局势移到另一方案', 'SITUATION_FORBIDDEN')
    await this.read('overviews', doc.overviewId, overviewSchema, signal); this.checkRelations(doc, (await this.list('situations', situationSchema, signal)).map(item => item.document)); await this.checkReferences(doc, signal); return doc
  }
  update(kind: Kind, id: string, version: string, input: OverviewInput | SituationInput, signal?: AbortSignal) { return this.enqueue(async () => {
    const old = await this.readDoc(kind, id, signal); if (old.version !== version) throw new SituationError('局势版本已变化', 'SITUATION_CONFLICT')
    if (old.document.contentStatus !== 'suggested') throw new SituationError('已确认资料不能直接覆盖', 'SITUATION_FORBIDDEN')
    if (await this.config.fs.stat(await this.target('candidates', id), signal)) throw new SituationError('局势已有待审候选', 'SITUATION_CONFLICT')
    const doc = await this.makeDoc(kind, id, input, old.document, signal); return { path: old.path, version: await this.write(this.folder(kind), id, doc, { kind: 'replaceIfVersion', version: old.version }, signal) }
  }) }
  prepare(kind: Kind, id: string, version: string, input: OverviewInput | SituationInput, signal?: AbortSignal) { return this.enqueue(async () => {
    const old = await this.readDoc(kind, id, signal); if (old.version !== version) throw new SituationError('局势版本已变化', 'SITUATION_CONFLICT')
    if (old.document.contentStatus !== 'confirmed') throw new SituationError('未确认资料使用初始化更新', 'SITUATION_FORBIDDEN')
    const doc = await this.makeDoc(kind, id, input, old.document, signal); const candidate = candidateSchema.parse({ formatVersion: 1, worldId: this.worldId, kind, id, baseline: version, document: doc })
    return { path: this.path('candidates', id), version: await this.write('candidates', id, candidate, { kind: 'createIfAbsent' }, signal) }
  }) }
  readCandidate(kind: Kind, id: string, signal?: AbortSignal) { return this.enqueue(async () => {
    const old = await this.readDoc(kind, id, signal); const candidate = await this.read('candidates', id, candidateSchema, signal); const doc = candidate.document
    if (doc.kind !== kind || doc.document.id !== id || doc.document.worldId !== this.worldId || doc.document.contentStatus !== 'suggested' || (kind === 'situation') !== ('overviewId' in doc.document)) throw new SituationError('局势候选身份无效', 'SITUATION_INVALID_DOCUMENT')
    return { ...candidate, stale: old.version !== doc.baseline }
  }) }
  close(): Promise<void> { if (!this.closing) { this.closed = true; this.closing = this.tail.then(() => { worlds.delete(this.worldId); roots.delete(this.root.targetKey) }) } return this.closing }
}
