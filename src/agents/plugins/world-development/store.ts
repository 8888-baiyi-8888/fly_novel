import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, join, resolve } from 'node:path'
import type { FileSystem, FsTarget, FsVersion } from '@fly-novel/fs'
import { z } from 'zod'
import { contentSchema, documentSchema, idSchema, kindSchema, parseDocumentJson, type DevelopmentContent, type DevelopmentDocument, type DevelopmentKind } from './format.js'

const folders: Record<DevelopmentKind, string> = { 'macro-blueprint': 'macro-development/blueprints', direction: 'macro-development/directions', proposal: 'macro-development/proposals', storyline: 'storylines/stories', 'growth-line': 'storylines/growth-lines', 'growth-blueprint': 'character-growth/blueprints', 'growth-item': 'character-growth/items' }
const candidateSchema = z.object({ formatVersion: z.literal(1), worldId: z.string().trim().min(1), id: idSchema, kind: kindSchema, baseline: z.string().min(1), document: documentSchema }).strict()
export class DevelopmentError extends Error { constructor(message: string, readonly code: string, readonly path?: string, options?: ErrorOptions) { super(message, options); this.name = 'DevelopmentError' } }
export type DevelopmentResolver = (type: string, id: string, signal?: AbortSignal) => Promise<{ id: string; worldId: string; version?: string } | null | undefined>
export type SituationResolver = (overviewId: string, situationId: string | null, signal?: AbortSignal) => Promise<{ worldId: string; overviewId: string; situationId: string | null; version?: string } | null | undefined>
export interface DevelopmentStoreConfig { fs: FileSystem; root: string; worldId: string; phase: 'initialization'; access: 'read-only' | 'read-write'; singleWriterProcess: true; resolveReference?: DevelopmentResolver; resolveSituation?: SituationResolver; maxDocumentBytes?: number; maxDocuments?: number }
export interface StoredDevelopment { document: DevelopmentDocument; path: string; version: FsVersion }
export interface DevelopmentSnapshot { items: StoredDevelopment[]; version: string }
const occupiedWorlds = new Set<string>(); const occupiedRoots = new Set<string>()

/** 由可信应用持有的初始化规划存储；只保证单进程内串行。 */
export class DevelopmentStore {
  private tail: Promise<void> = Promise.resolve(); private closed = false; private closing?: Promise<void>
  private constructor(private readonly config: DevelopmentStoreConfig, private readonly rootPath: string, private readonly root: FsTarget, private readonly maxBytes: number, private readonly maxDocuments: number) {}
  get worldId() { return this.config.worldId }
  get rootDirectory() { return this.rootPath }
  get writable() { return this.config.access === 'read-write' }
  static async open(config: DevelopmentStoreConfig): Promise<DevelopmentStore> {
    if (!config?.fs || config.phase !== 'initialization' || config.singleWriterProcess !== true || typeof config.worldId !== 'string' || !config.worldId || config.worldId.trim() !== config.worldId || typeof config.root !== 'string' || !isAbsolute(config.root) || !['read-only', 'read-write'].includes(config.access) || [config.resolveReference, config.resolveSituation].some(value => value !== undefined && typeof value !== 'function')) throw new DevelopmentError('规划存储配置无效', 'DEVELOPMENT_INVALID_CONFIG')
    const maxBytes = config.maxDocumentBytes ?? 1048576; const maxDocuments = config.maxDocuments ?? 10000
    if (![maxBytes, maxDocuments].every(value => Number.isSafeInteger(value) && value > 0)) throw new DevelopmentError('规划存储限制无效', 'DEVELOPMENT_INVALID_CONFIG')
    const path = resolve(config.root); const root = await config.fs.resolve(path); const info = await config.fs.lstat(path)
    if (!info || info.type !== 'directory' || config.fs.processPath(root) !== path) throw new DevelopmentError('规划根须为现有真实目录', 'DEVELOPMENT_INVALID_CONFIG')
    if (occupiedWorlds.has(config.worldId) || occupiedRoots.has(root.targetKey)) throw new DevelopmentError('规划世界或目录正在使用', 'DEVELOPMENT_BUSY')
    occupiedWorlds.add(config.worldId); occupiedRoots.add(root.targetKey)
    const store = new DevelopmentStore({ ...config }, path, root, maxBytes, maxDocuments)
    try { for (const folder of [...Object.values(folders), 'candidates']) await store.directory(folder); return store }
    catch (error) { occupiedWorlds.delete(config.worldId); occupiedRoots.delete(root.targetKey); throw error }
  }
  private enqueue<T>(fn: () => Promise<T>): Promise<T> { if (this.closed) return Promise.reject(new DevelopmentError('规划存储已关闭', 'DEVELOPMENT_CLOSED')); const result = this.tail.then(fn); this.tail = result.then(() => undefined, () => undefined); return result }
  private async directory(folder: string): Promise<FsTarget> {
    const path = join(this.rootPath, folder); const info = await this.config.fs.lstat(path); const target = await this.config.fs.resolve(path)
    if (!info || info.type !== 'directory' || !this.config.fs.contains(this.root, target) || this.config.fs.processPath(target) !== path) throw new DevelopmentError('规划目录无效或超出授权范围', 'DEVELOPMENT_FORBIDDEN', folder)
    return target
  }
  private path(folder: string, id: string) { return `${folder}/${id}.json` }
  private async target(folder: string, id: string): Promise<FsTarget> {
    idSchema.parse(id); const path = join(this.rootPath, folder, `${id}.json`); const root = await this.config.fs.resolve(this.rootPath)
    if (root.targetKey !== this.root.targetKey || (await this.config.fs.lstat(this.rootPath))?.type !== 'directory') throw new DevelopmentError('规划根已变化', 'DEVELOPMENT_CONFLICT')
    await this.directory(folder); const info = await this.config.fs.lstat(path)
    if (info && info.type !== 'file') throw new DevelopmentError('规划文档不是普通文件', 'DEVELOPMENT_FORBIDDEN', this.path(folder, id))
    const target = await this.config.fs.resolve(path)
    if (!this.config.fs.contains(this.root, target) || this.config.fs.processPath(target) !== path) throw new DevelopmentError('规划路径超出授权范围', 'DEVELOPMENT_FORBIDDEN')
    return target
  }
  private async bytes(folder: string, id: string, signal?: AbortSignal) {
    signal?.throwIfAborted(); const path = this.path(folder, id); const target = await this.target(folder, id); const before = await this.config.fs.stat(target, signal)
    if (!before) throw new DevelopmentError('规划文档不存在', 'DEVELOPMENT_NOT_FOUND', path)
    const bytes = await this.config.fs.readBytes(target, signal, this.maxBytes); const after = await this.config.fs.stat(target, signal); const fresh = await this.target(folder, id)
    if (!after || before.version !== after.version || fresh.targetKey !== target.targetKey) throw new DevelopmentError('规划读取期间变化', 'DEVELOPMENT_CONFLICT', path)
    let text: string; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch (error) { throw new DevelopmentError('规划编码无效', 'DEVELOPMENT_INVALID_DOCUMENT', path, { cause: error }) }
    return { text, path, version: after.version }
  }
  private async read(kind: DevelopmentKind, id: string, signal?: AbortSignal): Promise<StoredDevelopment> {
    const file = await this.bytes(folders[kind], id, signal); let document: DevelopmentDocument
    try { document = parseDocumentJson(file.text, documentSchema) } catch (error) { throw new DevelopmentError('规划文件损坏或格式无效', 'DEVELOPMENT_INVALID_DOCUMENT', file.path, { cause: error }) }
    if (document.worldId !== this.worldId || document.kind !== kind || document.id !== id) throw new DevelopmentError('规划身份或世界不匹配', 'DEVELOPMENT_INVALID_DOCUMENT', file.path)
    return { document, path: file.path, version: file.version }
  }
  private async scan(signal?: AbortSignal): Promise<DevelopmentSnapshot> {
    const items: StoredDevelopment[] = []
    for (const kind of kindSchema.options) {
      const folder = folders[kind]; const entries = await this.config.fs.listDir(await this.directory(folder), signal)
      if (entries.length > this.maxDocuments || items.length + entries.length > this.maxDocuments) throw new DevelopmentError('规划文件数量超过限制', 'DEVELOPMENT_LIMIT')
      for (const entry of entries) if (entry.name.endsWith('.json')) { const id = entry.name.slice(0, -5); if (!idSchema.safeParse(id).success) throw new DevelopmentError('规划文件名无效', 'DEVELOPMENT_INVALID_DOCUMENT', `${folder}/${entry.name}`); items.push(await this.read(kind, id, signal)) }
    }
    items.sort((a, b) => a.path.localeCompare(b.path)); this.validateGraph(items.map(item => item.document))
    for (const item of items) if ((await this.config.fs.stat(await this.target(folders[item.document.kind], item.document.id), signal))?.version !== item.version) throw new DevelopmentError('规划扫描期间变化', 'DEVELOPMENT_CONFLICT')
    for (const kind of kindSchema.options) {
      const names = (await this.config.fs.listDir(await this.directory(folders[kind]), signal)).filter(item => item.name.endsWith('.json')).map(item => item.name).sort()
      if (JSON.stringify(names) !== JSON.stringify(items.filter(item => item.document.kind === kind).map(item => `${item.document.id}.json`).sort())) throw new DevelopmentError('规划目录扫描期间变化', 'DEVELOPMENT_CONFLICT')
    }
    return { items, version: createHash('sha256').update(JSON.stringify(items)).digest('hex') }
  }
  private validateGraph(docs: DevelopmentDocument[]) {
    const ids = new Set<string>(); const people = new Set<string>(); const singletons = new Set<string>()
    for (const item of docs) {
      if (item.worldId !== this.worldId || ids.has(item.id)) throw new DevelopmentError('规划 ID 重复或世界不符', 'DEVELOPMENT_INVALID_DOCUMENT'); ids.add(item.id)
      if ((item.kind === 'macro-blueprint' || item.kind === 'growth-blueprint') && singletons.has(item.kind)) throw new DevelopmentError('世界总览重复', 'DEVELOPMENT_CONFLICT')
      singletons.add(item.kind)
      if (item.kind === 'growth-line' && item.person?.kind === 'linked') { if (people.has(item.person.id)) throw new DevelopmentError('人物已有成长线', 'DEVELOPMENT_CONFLICT'); people.add(item.person.id) }
    }
    for (const item of docs) for (const link of item.links) if (!docs.some(other => other.id === link.targetId && other.kind === link.targetKind)) throw new DevelopmentError('规划关联目标缺失或类型不符', 'DEVELOPMENT_INVALID_DOCUMENT')
  }
  private async verify(doc: DevelopmentDocument, signal?: AbortSignal) {
    const references = doc.references.filter(item => item.kind === 'linked')
    const person = doc.person?.kind === 'linked' ? [{ kind: 'linked' as const, type: 'person' as const, id: doc.person.id }] : []
    for (const ref of [...references, ...person]) {
      if (!this.config.resolveReference) throw new DevelopmentError('外部引用解析器未配置', 'DEVELOPMENT_REFERENCE_UNAVAILABLE')
      signal?.throwIfAborted(); const found = await this.config.resolveReference(ref.type, ref.id, signal); signal?.throwIfAborted()
      if (found === undefined) throw new DevelopmentError('该类引用解析器未配置', 'DEVELOPMENT_REFERENCE_UNAVAILABLE')
      if (!found || found.id !== ref.id || found.worldId !== this.worldId) throw new DevelopmentError('引用不存在或世界不匹配', 'DEVELOPMENT_INVALID_DOCUMENT')
    }
    if (doc.applicability.kind === 'scoped') for (const scope of doc.applicability.scopes) for (const situationId of [null, ...scope.situationIds]) {
      if (!this.config.resolveSituation) throw new DevelopmentError('局势解析器未配置', 'DEVELOPMENT_REFERENCE_UNAVAILABLE')
      signal?.throwIfAborted(); const found = await this.config.resolveSituation(scope.overviewId, situationId, signal); signal?.throwIfAborted()
      if (found === undefined) throw new DevelopmentError('局势解析器未配置', 'DEVELOPMENT_REFERENCE_UNAVAILABLE')
      if (!found || found.worldId !== this.worldId || found.overviewId !== scope.overviewId || found.situationId !== situationId) throw new DevelopmentError('局势方案、条目或世界不匹配', 'DEVELOPMENT_INVALID_DOCUMENT')
    }
  }
  private async write(folder: string, id: string, value: unknown, expected: { kind: 'createIfAbsent' } | { kind: 'replaceIfVersion'; version: FsVersion }, signal?: AbortSignal): Promise<FsVersion> {
    const path = this.path(folder, id); if (!this.writable) throw new DevelopmentError('规划存储只读', 'DEVELOPMENT_FORBIDDEN', path)
    signal?.throwIfAborted(); const text = `${JSON.stringify(value, null, 2)}\n`; if (Buffer.byteLength(text) > this.maxBytes) throw new DevelopmentError('规划文档超出大小限制', 'DEVELOPMENT_LIMIT', path)
    const target = await this.target(folder, id)
    try { return (await this.config.fs.writeText(target, text, expected, signal)).version }
    catch (error) {
      if (error instanceof Error && 'code' in error && (error.code === 'FS_STALE_VERSION' || error.code === 'FS_NOT_OBSERVED')) throw new DevelopmentError('规划文件已存在或版本变化', 'DEVELOPMENT_CONFLICT', path, { cause: error })
      if (error instanceof Error && 'code' in error && error.code === 'FS_ABORTED') throw error
      throw new DevelopmentError('规划发布结果不确定，请核查目标', 'DEVELOPMENT_COMMIT_UNKNOWN', path, { cause: error })
    }
  }
  /** 创建待审规划；引用、局势和唯一性由可信句柄验证。 */
  create(kind: DevelopmentKind, input: DevelopmentContent, signal?: AbortSignal) { return this.enqueue(async () => {
    kindSchema.parse(kind); const snapshot = await this.scan(signal); if (snapshot.items.length >= this.maxDocuments) throw new DevelopmentError('规划数量超限', 'DEVELOPMENT_LIMIT')
    const doc = documentSchema.parse({ ...contentSchema.parse(input), formatVersion: 1, worldId: this.worldId, id: randomUUID(), kind, contentStatus: 'suggested' })
    this.validateGraph([...snapshot.items.map(item => item.document), doc]); await this.verify(doc, signal)
    return { id: doc.id, path: this.path(folders[kind], doc.id), version: await this.write(folders[kind], doc.id, doc, { kind: 'createIfAbsent' }, signal) }
  }) }
  readDocument(kind: DevelopmentKind, id: string, signal?: AbortSignal) { return this.enqueue(async () => { kindSchema.parse(kind); idSchema.parse(id); const found = (await this.scan(signal)).items.find(item => item.document.kind === kind && item.document.id === id); if (!found) throw new DevelopmentError('规划文档不存在', 'DEVELOPMENT_NOT_FOUND'); return found }) }
  snapshot(signal?: AbortSignal) { return this.enqueue(() => this.scan(signal)) }
  update(kind: DevelopmentKind, id: string, version: string, input: DevelopmentContent, signal?: AbortSignal) { return this.enqueue(async () => {
    kindSchema.parse(kind); idSchema.parse(id); const snapshot = await this.scan(signal); const old = snapshot.items.find(item => item.document.kind === kind && item.document.id === id)
    if (!old) throw new DevelopmentError('规划不存在', 'DEVELOPMENT_NOT_FOUND'); if (old.version !== version) throw new DevelopmentError('规划版本变化', 'DEVELOPMENT_CONFLICT')
    if (old.document.contentStatus !== 'suggested') throw new DevelopmentError('已确认规划不能覆盖', 'DEVELOPMENT_FORBIDDEN')
    if (await this.config.fs.stat(await this.target('candidates', id), signal)) throw new DevelopmentError('已有候选', 'DEVELOPMENT_CONFLICT')
    const content = contentSchema.parse(input)
    if (old.document.person?.kind === 'unresolved' && content.person?.kind === 'linked') content.person.originalClue = old.document.person.description
    if (old.document.person?.kind === 'linked' && content.person?.kind === 'linked' && old.document.person.id === content.person.id && old.document.person.originalClue) content.person.originalClue = old.document.person.originalClue
    const doc = documentSchema.parse({ ...content, formatVersion: 1, worldId: this.worldId, id, kind, contentStatus: 'suggested' })
    this.validateGraph(snapshot.items.map(item => item.document.id === id ? doc : item.document)); await this.verify(doc, signal)
    return { path: old.path, version: await this.write(folders[kind], id, doc, { kind: 'replaceIfVersion', version: old.version }, signal) }
  }) }
  prepare(kind: DevelopmentKind, id: string, version: string, input: DevelopmentContent, signal?: AbortSignal) { return this.enqueue(async () => {
    kindSchema.parse(kind); idSchema.parse(id); const snapshot = await this.scan(signal); const old = snapshot.items.find(item => item.document.kind === kind && item.document.id === id)
    if (!old) throw new DevelopmentError('规划不存在', 'DEVELOPMENT_NOT_FOUND'); if (old.version !== version) throw new DevelopmentError('规划版本变化', 'DEVELOPMENT_CONFLICT')
    if (old.document.contentStatus !== 'confirmed') throw new DevelopmentError('未确认规划使用直接更新', 'DEVELOPMENT_FORBIDDEN')
    const content = contentSchema.parse(input)
    if (old.document.person?.kind === 'unresolved' && content.person?.kind === 'linked') content.person.originalClue = old.document.person.description
    if (old.document.person?.kind === 'linked' && content.person?.kind === 'linked' && old.document.person.id === content.person.id && old.document.person.originalClue) content.person.originalClue = old.document.person.originalClue
    const document = documentSchema.parse({ ...content, formatVersion: 1, worldId: this.worldId, id, kind, contentStatus: 'suggested' }); this.validateGraph(snapshot.items.map(item => item.document.id === id ? document : item.document)); await this.verify(document, signal)
    const candidate = candidateSchema.parse({ formatVersion: 1, worldId: this.worldId, id, kind, baseline: version, document })
    return { path: this.path('candidates', id), version: await this.write('candidates', id, candidate, { kind: 'createIfAbsent' }, signal) }
  }) }
  readCandidate(kind: DevelopmentKind, id: string, signal?: AbortSignal) { return this.enqueue(async () => {
    kindSchema.parse(kind); const old = await this.read(kind, id, signal); const file = await this.bytes('candidates', id, signal); let candidate: z.infer<typeof candidateSchema>
    try { candidate = parseDocumentJson(file.text, candidateSchema) } catch (error) { throw new DevelopmentError('规划候选损坏或格式无效', 'DEVELOPMENT_INVALID_DOCUMENT', file.path, { cause: error }) }
    if (candidate.id !== id || candidate.kind !== kind || candidate.worldId !== this.worldId || candidate.document.id !== id || candidate.document.kind !== kind || candidate.document.worldId !== this.worldId || candidate.document.contentStatus !== 'suggested') throw new DevelopmentError('规划候选身份不符', 'DEVELOPMENT_INVALID_DOCUMENT', file.path)
    return { candidate, path: file.path, version: file.version, stale: candidate.baseline !== old.version }
  }) }
  checkReference(type: string, id: string, observedVersion: string | null, signal?: AbortSignal) { return this.enqueue(async () => {
    idSchema.parse(id); if (!this.config.resolveReference) return { status: 'unconfigured' as const }
    signal?.throwIfAborted(); const found = await this.config.resolveReference(type, id, signal); signal?.throwIfAborted()
    if (found === undefined) return { status: 'unconfigured' as const }; if (!found) return { status: 'not_found' as const }
    if (found.id !== id || found.worldId !== this.worldId) throw new DevelopmentError('引用身份或世界不符', 'DEVELOPMENT_INVALID_DOCUMENT')
    if (!observedVersion || !found.version) return { status: 'version_unknown' as const }
    return { status: found.version === observedVersion ? 'current' as const : 'changed' as const }
  }) }
  /** 核验局势方案及可选条目归属；调用失败不伪装成未找到。 */
  checkSituation(overviewId: string, situationId: string | null, signal?: AbortSignal) { return this.enqueue(async () => {
    idSchema.parse(overviewId); if (situationId !== null) idSchema.parse(situationId)
    if (!this.config.resolveSituation) return { status: 'unconfigured' as const }
    signal?.throwIfAborted(); const found = await this.config.resolveSituation(overviewId, situationId, signal); signal?.throwIfAborted()
    if (found === undefined) return { status: 'unconfigured' as const }; if (!found) return { status: 'not_found' as const }
    if (found.worldId !== this.worldId || found.overviewId !== overviewId || found.situationId !== situationId) throw new DevelopmentError('局势身份或世界不符', 'DEVELOPMENT_INVALID_DOCUMENT')
    return { status: 'verified' as const, version: found.version ?? null }
  }) }
  close(): Promise<void> { if (!this.closing) { this.closed = true; this.closing = this.tail.then(() => { occupiedWorlds.delete(this.worldId); occupiedRoots.delete(this.root.targetKey) }) } return this.closing }
}
