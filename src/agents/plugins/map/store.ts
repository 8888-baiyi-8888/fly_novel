import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, join, resolve } from 'node:path'
import type { FileSystem, FsTarget, FsVersion } from '@fly-novel/fs'
import { CoordinatedOperations } from '@fly-novel/util'
import { mapConnectionSchema, mapIdSchema, mapPlaceSchema, worldMapSchema, formatMapDocument, parseMapConnection, parseMapPlace, parseWorldMap,
  type MapConnection, type MapPlace, type WorldMap } from './format.js'

export type MapStoreErrorCode = 'MAP_INVALID_CONFIG' | 'MAP_BUSY' | 'MAP_CLOSED' | 'MAP_FORBIDDEN' | 'MAP_NOT_FOUND' |
  'MAP_INVALID_DOCUMENT' | 'MAP_CONFLICT' | 'MAP_LIMIT' | 'MAP_COMMIT_UNKNOWN'

/** 地图存储错误；发布结果不确定时 path 为可核查的地图根内相对路径。 */
export class MapStoreError extends Error {
  constructor(message: string, readonly code: MapStoreErrorCode, readonly path?: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'MapStoreError'
  }
}

/** 由可信调用方提供后端和目录；调用方须确保同一世界只有一个写入进程。 */
export interface MapStoreConfig {
  fs: FileSystem
  root: string
  worldId: string
  access: 'read-only' | 'read-write'
  singleWriterProcess: true
  maxDocumentBytes?: number
  maxDocuments?: number
}

export interface StoredMapDocument<T> { document: T; path: string; version: FsVersion }
export interface CreatedMapDocument { id: string; path: string; version: FsVersion }
export interface MapSnapshot {
  overview: StoredMapDocument<WorldMap>
  places: StoredMapDocument<MapPlace>[]
  connections: StoredMapDocument<MapConnection>[]
  version: string
}

const occupiedWorlds = new Set<string>()
const occupiedRoots = new Set<string>()

/**
 * 持有一个世界地图目录的受控存储；不创建目录、注册模型工具或提供跨进程锁。
 * 同一实例内操作串行，调用方必须等待 close；失败和取消不会删除已有文件。
 */
export class MapStore {
  private tail: Promise<void> = Promise.resolve()
  private readonly operations = new CoordinatedOperations()
  private closed = false
  private closing?: Promise<void>
  private constructor(private readonly fs: FileSystem, private readonly rootPath: string, private readonly root: FsTarget,
    private readonly worldId: string, private readonly access: 'read-only' | 'read-write',
    private readonly maxDocumentBytes: number, private readonly maxDocuments: number) {}

  /** 此句柄是否允许写入；只读工具可绑定到读写句柄。 */
  get writable(): boolean { return this.access === 'read-write' }
  /** 供可信应用核对装配的世界和目录；不提供给模型选择。 */
  get boundWorldId(): string { return this.worldId }
  get rootDirectory(): string { return this.rootPath }
  /** 供可信装配核验文件后端是否参与世界协调。 */
  get fileSystem(): FileSystem { return this.fs }

  /**
   * 打开现有真实地图根及 places、connections 子目录，不初始化或修改资料。
   * @param config 可信世界、后端、授权及可选读取限制。
   * @returns 独占的地图存储句柄，使用后必须等待 close。
   * @throws 配置无效、目录越界、符号链接或同世界 / 目录已打开时拒绝。
   */
  static async open(config: MapStoreConfig): Promise<MapStore> {
    if (!config || config.singleWriterProcess !== true || !config.fs || typeof config.worldId !== 'string' || !config.worldId ||
        config.worldId.trim() !== config.worldId || typeof config.root !== 'string' || !isAbsolute(config.root) ||
        (config.access !== 'read-only' && config.access !== 'read-write')) throw new MapStoreError('地图存储配置无效', 'MAP_INVALID_CONFIG')
    const maxDocumentBytes = config.maxDocumentBytes ?? 1024 * 1024
    const maxDocuments = config.maxDocuments ?? 10000
    if (![maxDocumentBytes, maxDocuments].every(value => Number.isSafeInteger(value) && value > 0)) throw new MapStoreError('地图存储限制必须为正整数', 'MAP_INVALID_CONFIG')
    const path = resolve(config.root)
    const physical = await config.fs.resolve(path)
    const info = await config.fs.lstat(path)
    if (!info || info.type !== 'directory' || config.fs.processPath(physical) !== path) throw new MapStoreError('地图根必须是现有真实绝对目录', 'MAP_INVALID_CONFIG')
    if (occupiedWorlds.has(config.worldId) || occupiedRoots.has(physical.targetKey)) throw new MapStoreError('世界地图或目录正在使用', 'MAP_BUSY')
    occupiedWorlds.add(config.worldId); occupiedRoots.add(physical.targetKey)
    const store = new MapStore(config.fs, path, physical, config.worldId, config.access, maxDocumentBytes, maxDocuments)
    try { await store.directory('places'); await store.directory('connections'); return store }
    catch (error) { occupiedWorlds.delete(config.worldId); occupiedRoots.delete(physical.targetKey); throw error }
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new MapStoreError('地图存储已关闭', 'MAP_CLOSED'))
    return this.operations.run([this.rootPath], () => {
      const result = this.tail.then(fn)
      this.tail = result.then(() => undefined, () => undefined)
      return result
    })
  }

  private async directory(name: 'places' | 'connections'): Promise<FsTarget> {
    const path = join(this.rootPath, name)
    const info = await this.fs.lstat(path)
    if (!info || info.type !== 'directory') throw new MapStoreError('地图子目录必须为现有真实目录', 'MAP_INVALID_CONFIG', name)
    const target = await this.fs.resolve(path)
    if (!this.fs.contains(this.root, target) || this.fs.processPath(target) !== path) throw new MapStoreError('地图子目录超出授权范围', 'MAP_FORBIDDEN', name)
    return target
  }

  private async target(path: string): Promise<FsTarget> {
    const absolute = join(this.rootPath, path)
    const rootNow = await this.fs.resolve(this.rootPath)
    if (rootNow.targetKey !== this.root.targetKey || (await this.fs.lstat(this.rootPath))?.type !== 'directory') throw new MapStoreError('地图根目录已变化', 'MAP_CONFLICT')
    if (path.startsWith('places/')) await this.directory('places')
    if (path.startsWith('connections/')) await this.directory('connections')
    const info = await this.fs.lstat(absolute)
    if (info && info.type !== 'file') throw new MapStoreError('地图文档必须是普通文件', 'MAP_FORBIDDEN', path)
    const target = await this.fs.resolve(absolute)
    if (!this.fs.contains(this.root, target)) throw new MapStoreError('地图文档超出授权范围', 'MAP_FORBIDDEN', path)
    return target
  }

  private async read<T>(path: string, parse: (text: string) => T, signal?: AbortSignal): Promise<StoredMapDocument<T>> {
    signal?.throwIfAborted()
    const target = await this.target(path)
    const before = await this.fs.stat(target, signal)
    if (!before) throw new MapStoreError('地图文档不存在', 'MAP_NOT_FOUND', path)
    if (before.type !== 'file') throw new MapStoreError('地图文档不是普通文件', 'MAP_FORBIDDEN', path)
    const bytes = await this.fs.readBytes(target, signal, this.maxDocumentBytes)
    const after = await this.fs.stat(target, signal)
    const fresh = await this.target(path)
    if (!after || after.version !== before.version || fresh.targetKey !== target.targetKey) throw new MapStoreError('地图文档读取期间变化', 'MAP_CONFLICT', path)
    let document: T
    try { document = parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
    catch (error) { throw new MapStoreError('地图文档损坏、格式无效或版本不支持', 'MAP_INVALID_DOCUMENT', path, { cause: error }) }
    return { document, path, version: after.version }
  }

  private async map(signal?: AbortSignal): Promise<StoredMapDocument<WorldMap>> {
    const result = await this.read('map.json', parseWorldMap, signal)
    if (result.document.worldId !== this.worldId) throw new MapStoreError('地图世界身份不匹配', 'MAP_INVALID_DOCUMENT', result.path)
    return result
  }

  private async places(map: WorldMap, signal?: AbortSignal): Promise<Map<string, MapPlace>> {
    const dir = await this.directory('places')
    const entries = await this.fs.listDir(dir, signal)
    if (entries.length > this.maxDocuments) throw new MapStoreError('地点文档数量超过限制', 'MAP_LIMIT')
    const all = new Map<string, MapPlace>()
    for (const entry of entries) {
      signal?.throwIfAborted()
      if (!entry.name.endsWith('.json')) continue
      const id = entry.name.slice(0, -5)
      if (!mapIdSchema.safeParse(id).success) throw new MapStoreError('地点文件名无效', 'MAP_INVALID_DOCUMENT', `places/${entry.name}`)
      const place = await this.read(`places/${id}.json`, parseMapPlace, signal)
      if (place.document.id !== id || place.document.worldId !== this.worldId || all.has(id)) throw new MapStoreError('地点身份无效或重复', 'MAP_INVALID_DOCUMENT', place.path)
      all.set(id, place.document)
    }
    this.validateGraph(map, all)
    return all
  }

  private validateGraph(map: WorldMap, all: Map<string, MapPlace>): void {
    const layers = new Set(map.layers.map(layer => layer.id))
    const done = new Set<string>(); const active = new Set<string>()
    for (const place of all.values()) for (const edge of place.parents) {
      if (!layers.has(edge.layerId)) throw new MapStoreError('地点引用未知地图层面', 'MAP_INVALID_DOCUMENT')
      const stack: { id: string; exit: boolean }[] = [{ id: place.id, exit: false }]
      while (stack.length) {
        const item = stack.pop()!
        const key = JSON.stringify([item.id, edge.layerId])
        if (item.exit) { active.delete(key); done.add(key); continue }
        if (active.has(key)) throw new MapStoreError('地点父级存在循环', 'MAP_INVALID_DOCUMENT')
        if (done.has(key)) continue
        const current = all.get(item.id)
        if (!current) throw new MapStoreError('地点父级不存在', 'MAP_INVALID_DOCUMENT')
        active.add(key); stack.push({ id: item.id, exit: true })
        for (const link of current.parents.filter(parent => parent.layerId === edge.layerId)) {
          if (link.parent.kind === 'place') {
            const parent = all.get(link.parent.id)
            if (!parent || !parent.parents.some(parentLink => parentLink.layerId === edge.layerId)) throw new MapStoreError('地点父级不存在或不属于同一层面', 'MAP_INVALID_DOCUMENT')
            if (parent.detailLevel === 'unexpanded') throw new MapStoreError('父地点必须至少有概况', 'MAP_INVALID_DOCUMENT')
            stack.push({ id: parent.id, exit: false })
          }
        }
      }
    }
  }

  private async write(path: string, value: WorldMap | MapPlace | MapConnection, expected: { kind: 'createIfAbsent' } | { kind: 'replaceIfVersion'; version: FsVersion }, signal?: AbortSignal): Promise<FsVersion> {
    if (this.access !== 'read-write') throw new MapStoreError('当前地图存储只读', 'MAP_FORBIDDEN')
    signal?.throwIfAborted()
    const content = formatMapDocument(value)
    if (Buffer.byteLength(content, 'utf8') > this.maxDocumentBytes) throw new MapStoreError('地图文档超过大小限制', 'MAP_LIMIT', path)
    const target = await this.target(path)
    try { return (await this.fs.writeText(target, content, expected, signal)).version }
    catch (error) {
      if (error instanceof Error && 'code' in error && (error.code === 'FS_STALE_VERSION' || error.code === 'FS_NOT_OBSERVED')) throw new MapStoreError('地图文档已存在或版本已变化', 'MAP_CONFLICT', path, { cause: error })
      if (error instanceof Error && 'code' in error && error.code === 'FS_ABORTED') throw error
      throw new MapStoreError('地图文档发布结果不确定，请核查目标', 'MAP_COMMIT_UNKNOWN', path, { cause: error })
    }
  }

  /** 创建世界概览；已存在时拒绝覆盖。 */
  createOverview(input: Omit<WorldMap, 'formatVersion' | 'worldId' | 'reviewStatus'>, signal?: AbortSignal): Promise<{ path: string; version: FsVersion }> {
    return this.enqueue(async () => {
      const document = worldMapSchema.parse({ ...input, formatVersion: 1, worldId: this.worldId, reviewStatus: 'suggested' })
      const path = 'map.json'
      const version = await this.write(path, document, { kind: 'createIfAbsent' }, signal)
      return { path, version }
    })
  }

  /** 读取当前世界概览及后端版本。 */
  readOverview(signal?: AbortSignal): Promise<StoredMapDocument<WorldMap>> { return this.enqueue(() => this.map(signal)) }

  /** 生成地点身份并创建建议；先验证现有父级图和世界层面。 */
  createPlace(input: Omit<MapPlace, 'formatVersion' | 'worldId' | 'id' | 'reviewStatus'>, signal?: AbortSignal): Promise<CreatedMapDocument> {
    return this.enqueue(async () => {
      const map = (await this.map(signal)).document
      const all = await this.places(map, signal)
      if (all.size >= this.maxDocuments) throw new MapStoreError('地点文档数量超过限制', 'MAP_LIMIT')
      const id = randomUUID()
      if (all.has(id)) throw new MapStoreError('生成的地点身份已存在', 'MAP_CONFLICT')
      const document = mapPlaceSchema.parse({ ...input, formatVersion: 1, worldId: this.worldId, id, reviewStatus: 'suggested' })
      all.set(id, document); this.validateGraph(map, all)
      const path = `places/${id}.json`
      const version = await this.write(path, document, { kind: 'createIfAbsent' }, signal)
      return { id, path, version }
    })
  }

  /** 按地点 ID 读取文档；读取前验证已登记地点图没有损坏、断链或循环。 */
  readPlace(id: string, signal?: AbortSignal): Promise<StoredMapDocument<MapPlace>> {
    return this.enqueue(async () => {
      mapIdSchema.parse(id)
      const all = await this.places((await this.map(signal)).document, signal)
      if (!all.has(id)) throw new MapStoreError('地点不存在', 'MAP_NOT_FOUND')
      const found = await this.read(`places/${id}.json`, parseMapPlace, signal)
      if (found.document.worldId !== this.worldId || found.document.id !== id) throw new MapStoreError('地点身份不匹配', 'MAP_INVALID_DOCUMENT', found.path)
      return found
    })
  }

  /**
   * 校验已有地点的候选及其在当前地点图中的父级关系，不写入当前资料。
   * @param value 已有地点的完整候选。
   * @param signal 可选取消信号。
   * @throws 地点不存在、世界不匹配、图无效或读取失败时拒绝。
   */
  validatePlaceCandidate(value: MapPlace, signal?: AbortSignal): Promise<void> {
    return this.enqueue(async () => {
      const candidate = mapPlaceSchema.parse(value)
      if (candidate.worldId !== this.worldId) throw new MapStoreError('地点世界身份不匹配', 'MAP_INVALID_DOCUMENT')
      const map = (await this.map(signal)).document
      const all = await this.places(map, signal)
      if (!all.has(candidate.id)) throw new MapStoreError('地点不存在', 'MAP_NOT_FOUND')
      all.set(candidate.id, candidate)
      this.validateGraph(map, all)
    })
  }

  /** 按已读取版本发布已有地点，重新校验完整地点图；调用方负责用户授权和跨模块协调。 */
  publishPlaceCandidate(value: MapPlace, expected: FsVersion, signal?: AbortSignal): Promise<{ path: string; version: FsVersion }> {
    return this.enqueue(async () => {
      const candidate = mapPlaceSchema.parse(value)
      if (candidate.worldId !== this.worldId) throw new MapStoreError('地点世界身份不匹配', 'MAP_INVALID_DOCUMENT')
      const map = (await this.map(signal)).document
      const all = await this.places(map, signal)
      if (!all.has(candidate.id)) throw new MapStoreError('地点不存在', 'MAP_NOT_FOUND')
      all.set(candidate.id, candidate)
      this.validateGraph(map, all)
      const path = `places/${candidate.id}.json`
      const version = await this.write(path, candidate, { kind: 'replaceIfVersion', version: expected }, signal)
      return { path, version }
    })
  }

  private async checkConnection(value: MapConnection, signal?: AbortSignal): Promise<void> {
    const all = await this.places((await this.map(signal)).document, signal)
    if (!all.has(value.fromId) || !all.has(value.toId)) throw new MapStoreError('连通的地点不存在', 'MAP_INVALID_DOCUMENT')
  }

  /** 创建独立连通设定；成功写入即为当前设定。 */
  createConnection(input: Omit<MapConnection, 'formatVersion' | 'worldId' | 'id'>, signal?: AbortSignal): Promise<CreatedMapDocument> {
    return this.enqueue(async () => {
      const dir = await this.directory('connections')
      if ((await this.fs.listDir(dir, signal)).length >= this.maxDocuments) throw new MapStoreError('连通文档数量超过限制', 'MAP_LIMIT')
      const id = randomUUID()
      const document = mapConnectionSchema.parse({ ...input, formatVersion: 1, worldId: this.worldId, id })
      await this.checkConnection(document, signal)
      const path = `connections/${id}.json`
      const version = await this.write(path, document, { kind: 'createIfAbsent' }, signal)
      return { id, path, version }
    })
  }

  /** 按连通 ID 读取当前设定及后端版本。 */
  readConnection(id: string, signal?: AbortSignal): Promise<StoredMapDocument<MapConnection>> {
    return this.enqueue(async () => {
      mapIdSchema.parse(id)
      const found = await this.read(`connections/${id}.json`, parseMapConnection, signal)
      if (found.document.worldId !== this.worldId || found.document.id !== id) throw new MapStoreError('连通身份不匹配', 'MAP_INVALID_DOCUMENT', found.path)
      await this.checkConnection(found.document, signal)
      return found
    })
  }

  /** 读取并校验查询所需资料；版本覆盖所有扫描文件，扫描不是跨进程原子快照。 */
  snapshot(signal?: AbortSignal): Promise<MapSnapshot> {
    return this.enqueue(async () => {
      const overview = await this.map(signal)
      const graph = await this.places(overview.document, signal)
      const places: StoredMapDocument<MapPlace>[] = []
      for (const [id, value] of graph) {
        const entry = await this.read(`places/${id}.json`, parseMapPlace, signal)
        if (JSON.stringify(value) !== JSON.stringify(entry.document)) throw new MapStoreError('扫描期间地点发生变化', 'MAP_CONFLICT')
        places.push(entry)
      }
      const dir = await this.directory('connections')
      const entries = await this.fs.listDir(dir, signal)
      if (entries.length > this.maxDocuments) throw new MapStoreError('连通文档数量超过限制', 'MAP_LIMIT')
      const connections: StoredMapDocument<MapConnection>[] = []
      for (const item of entries) {
        signal?.throwIfAborted()
        if (!item.name.endsWith('.json')) continue
        const id = item.name.slice(0, -5)
        if (!mapIdSchema.safeParse(id).success) throw new MapStoreError('连通文件名无效', 'MAP_INVALID_DOCUMENT')
        const entry = await this.read(`connections/${id}.json`, parseMapConnection, signal)
        const value = entry.document
        if (value.id !== id || value.worldId !== this.worldId || !graph.has(value.fromId) || !graph.has(value.toId)) throw new MapStoreError('连通身份或端点无效', 'MAP_INVALID_DOCUMENT', entry.path)
        connections.push(entry)
      }
      places.sort((a, b) => a.path.localeCompare(b.path)); connections.sort((a, b) => a.path.localeCompare(b.path))
      for (const entry of [overview, ...places, ...connections]) {
        const target = await this.target(entry.path)
        if ((await this.fs.stat(target, signal))?.version !== entry.version) throw new MapStoreError('扫描期间地图文档发生变化', 'MAP_CONFLICT')
      }
      for (const [name, documents] of [['places', places], ['connections', connections]] as const) {
        const names = (await this.fs.listDir(await this.directory(name), signal)).filter(entry => entry.name.endsWith('.json')).map(entry => entry.name).sort()
        if (JSON.stringify(names) !== JSON.stringify(documents.map(entry => entry.path.slice(name.length + 1)).sort())) throw new MapStoreError('扫描期间地图目录发生变化', 'MAP_CONFLICT')
      }
      const version = createHash('sha256').update(JSON.stringify([overview, places, connections])).digest('hex')
      return { overview, places, connections, version }
    })
  }

  /** 按读取到的版本覆盖连通设定；过期版本被拒绝，身份保持不变。 */
  updateConnection(id: string, version: string, input: Omit<MapConnection, 'formatVersion' | 'worldId' | 'id'>, signal?: AbortSignal): Promise<{ path: string; version: FsVersion }> {
    return this.enqueue(async () => {
      mapIdSchema.parse(id)
      const path = `connections/${id}.json`
      const existing = await this.read(path, parseMapConnection, signal)
      if (existing.document.worldId !== this.worldId || existing.document.id !== id) throw new MapStoreError('连通身份不匹配', 'MAP_INVALID_DOCUMENT', path)
      if (existing.version !== version) throw new MapStoreError('连通文档版本已变化', 'MAP_CONFLICT', path)
      const document = mapConnectionSchema.parse({ ...input, formatVersion: 1, worldId: this.worldId, id })
      await this.checkConnection(document, signal)
      return { path, version: await this.write(path, document, { kind: 'replaceIfVersion', version: existing.version }, signal) }
    })
  }

  /** 拒绝新操作并等待已受理的操作结束，然后释放进程内占用。 */
  close(): Promise<void> {
    if (!this.closing) {
      this.closed = true
      this.closing = this.operations.drain().then(() => { occupiedWorlds.delete(this.worldId); occupiedRoots.delete(this.root.targetKey) })
    }
    return this.closing
  }
}
