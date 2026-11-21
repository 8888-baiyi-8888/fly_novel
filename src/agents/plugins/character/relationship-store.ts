import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import { CoordinatedOperations } from '@fly-novel/util'
import { characterRelationshipSchema, formatCharacterRelationship, parseCharacterRelationship, type CharacterRelationship } from './relationship-format.js'

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
const occupiedWorlds = new Set<string>()
const occupiedRoots = new Set<string>()
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
type ParticipantInput = { kind: 'linked'; id: string } | { kind: 'unresolved'; description: string }
type RelationInput = { name: string; direction: 'a-to-b' | 'b-to-a' | 'two-way'; description: string }
type Content = { participants: CharacterRelationship['participants']; relations: (Omit<CharacterRelationship['relations'][number], 'id'> & { id?: string })[] }
type Stored = { document: CharacterRelationship; version: string; path: string }

/** 发布结果不确定时保留目标路径，调用方须先核查。 */
export class CharacterRelationshipCommitUnknownError extends Error {
  readonly code = 'CHARACTER_RELATIONSHIP_COMMIT_UNKNOWN'
  constructor(readonly path: string, cause: unknown) { super(`人物关系发布结果不确定，请核查目标文件 ${path}`, { cause }); this.name = 'CharacterRelationshipCommitUnknownError' }
}

/** 可信应用提供同世界人物解析；模型不能提供世界、目录或授权。 */
export interface CharacterRelationshipStoreConfig {
  root: string
  worldId: string
  phase: 'initialization'
  singleWriterProcess: true
  resolvePerson(id: string, signal?: AbortSignal): Promise<{ id: string; worldId: string } | null>
  maxDocuments?: number
}

/** 初始化关系存储：在单可信写入进程内串行检查配对并保存。 */
export class CharacterRelationshipStore {
  private readonly operations = new CoordinatedOperations()
  private tail: Promise<void> = Promise.resolve()
  private closing?: Promise<void>
  private closed = false
  private constructor(private readonly config: CharacterRelationshipStoreConfig, private readonly limit: number) {}

  /** 提供给可信装配以核对读取绑定。 */
  get worldId(): string { return this.config.worldId }

  /** 用于可信应用核对关系存储对应的负责人目录。 */
  get rootDirectory(): string { return this.config.root }

  /** 打开预先创建的真实目录；不初始化或迁移现有角色资料。 */
  static async open(config: CharacterRelationshipStoreConfig): Promise<CharacterRelationshipStore> {
    if (!config || config.phase !== 'initialization' || config.singleWriterProcess !== true || typeof config.resolvePerson !== 'function' ||
        typeof config.worldId !== 'string' || !config.worldId.trim() || config.worldId.trim() !== config.worldId ||
        typeof config.root !== 'string' || !isAbsolute(config.root) || resolve(config.root) !== await realpath(config.root) || !(await lstat(config.root)).isDirectory()) throw new Error('人物关系存储配置无效')
    const limit = config.maxDocuments ?? 10000
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('人物关系文件数量限制无效')
    if (occupiedWorlds.has(config.worldId) || occupiedRoots.has(config.root)) throw new Error('人物关系世界或目录正在使用')
    occupiedWorlds.add(config.worldId); occupiedRoots.add(config.root)
    return new CharacterRelationshipStore({ ...config }, limit)
  }

  private run<T>(action: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('人物关系存储已关闭'))
    return this.operations.run([this.config.root], () => { const result = this.tail.then(action); this.tail = result.then(() => undefined, () => undefined); return result })
  }
  /** 拒绝新操作，等待已受理操作并释放占用。 */
  close(): Promise<void> {
    if (!this.closing) { this.closed = true; this.closing = this.operations.drain().then(() => { occupiedWorlds.delete(this.config.worldId); occupiedRoots.delete(this.config.root) }) }
    return this.closing
  }
  private async checkRoot(): Promise<void> {
    if (await realpath(this.config.root) !== this.config.root || !(await lstat(this.config.root)).isDirectory()) throw new Error('人物关系目录已变化')
  }
  private path(id: string): string { return join(this.config.root, `${uuid.parse(id)}.json`) }
  private async readFile(id: string): Promise<Stored> {
    const path = this.path(id); const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || await realpath(path) !== path) throw new Error('人物关系文件必须是真实普通文件')
    if (info.size > 1024 * 1024) throw new Error('人物关系文件超过大小限制')
    const text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path))
    const document = parseCharacterRelationship(text)
    if (document.id !== id || document.worldId !== this.config.worldId) throw new Error('人物关系身份或世界不匹配')
    return { document, version: digest(text), path: `${id}.json` }
  }
  private pair(document: CharacterRelationship): string | undefined {
    const [a, b] = document.participants
    return a.kind === 'linked' && b.kind === 'linked' ? [a.id, b.id].sort().join(':') : undefined
  }
  private async scan(signal?: AbortSignal): Promise<Stored[]> {
    await this.checkRoot(); signal?.throwIfAborted()
    const names = (await readdir(this.config.root)).filter(name => name.endsWith('.json')).sort()
    if (names.length > this.limit) throw new Error('人物关系文件数量超限')
    const results: Stored[] = []; const pairs = new Set<string>()
    for (const name of names) {
      signal?.throwIfAborted(); const id = name.slice(0, -5); uuid.parse(id)
      const value = await this.readFile(id); const pair = this.pair(value.document)
      if (pair && pairs.has(pair)) throw new Error('人物关系配对重复')
      if (pair) pairs.add(pair); results.push(value)
    }
    return results
  }
  private async verify(document: CharacterRelationship, all: Stored[], signal?: AbortSignal): Promise<void> {
    for (const participant of document.participants) {
      if (participant.kind !== 'linked') continue
      signal?.throwIfAborted(); const found = await this.config.resolvePerson(participant.id, signal)
      if (!found || found.id !== participant.id || found.worldId !== this.config.worldId) throw new Error('人物引用不存在或世界不匹配')
    }
    const pair = this.pair(document)
    if (pair && all.some(value => value.document.id !== document.id && this.pair(value.document) === pair)) throw new Error('人物关系配对已存在')
  }
  private validateParticipants(old: CharacterRelationship, document: CharacterRelationship): void {
    for (let i = 0; i < 2; i++) {
      const previous = old.participants[i]; const next = document.participants[i]
      if (previous.kind === 'linked' && (next.kind !== 'linked' || next.id !== previous.id)) throw new Error('已关联人物不能直接替换')
      if (previous.kind === 'linked' && next.kind === 'linked' && JSON.stringify(previous.previousClue) !== JSON.stringify(next.previousClue)) throw new Error('已关联人物的原线索不能直接修改')
      if (previous.kind === 'unresolved' && next.kind === 'linked' && (next.previousClue?.clueId !== previous.clueId || next.previousClue.description !== previous.description)) throw new Error('关联人物须保留原线索')
      if (previous.kind === 'unresolved' && next.kind === 'unresolved' && next.clueId !== previous.clueId) throw new Error('线索身份不能更改')
    }
  }
  /** 创建一对人物的关系；文档、线索和条目 ID 由服务生成。 */
  create(input: { participants: [ParticipantInput, ParticipantInput]; relations: RelationInput[] }, signal?: AbortSignal): Promise<Stored> {
    return this.run(async () => {
      const all = await this.scan(signal); if (all.length >= this.limit) throw new Error('人物关系文件数量超限')
      const participants = input.participants.map(value => value.kind === 'linked' ? value : { ...value, clueId: randomUUID() })
      const document = characterRelationshipSchema.parse({ formatVersion: 1, worldId: this.config.worldId, id: randomUUID(), participants,
        relations: input.relations.map(value => ({ ...value, id: randomUUID() })), contentStatus: 'suggested' })
      await this.verify(document, all, signal); signal?.throwIfAborted()
      const text = formatCharacterRelationship(document); if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('人物关系文件超过大小限制')
      try { await writeFile(this.path(document.id), text, { flag: 'wx' }) }
      catch (error) { throw new CharacterRelationshipCommitUnknownError(`${document.id}.json`, error) }
      return { document, version: digest(text), path: `${document.id}.json` }
    })
  }
  /** 读取关系及其文件摘要；不存在或损坏时拒绝。 */
  read(id: string, signal?: AbortSignal): Promise<Stored> {
    return this.run(async () => { const all = await this.scan(signal); const value = all.find(item => item.document.id === id); if (!value) throw Object.assign(new Error('人物关系不存在'), { code: 'CHARACTER_RELATION_NOT_FOUND' }); return value })
  }
  /** 校验已有关系候选及人物引用，不写入当前资料；候选暂不支持新增关系条目。 */
  validateCandidate(value: CharacterRelationship, signal?: AbortSignal): Promise<void> {
    return this.run(async () => {
      const document = characterRelationshipSchema.parse(value)
      if (document.worldId !== this.worldId || document.contentStatus !== 'suggested') throw new Error('人物关系候选身份或状态无效')
      const all = await this.scan(signal); const old = all.find(item => item.document.id === document.id)
      if (!old) throw new Error('人物关系不存在')
      const oldIds = new Set(old.document.relations.map(item => item.id))
      if (document.relations.some(item => !oldIds.has(item.id))) throw new Error('人物关系候选暂不支持新增条目')
      this.validateParticipants(old.document, document)
      await this.verify(document, all, signal)
    })
  }
  /** 按人物及相对方向查询完整关系文档；分页版本反映关系文件而非人物姓名。 */
  query(input: { personId: string; direction?: 'outgoing' | 'incoming' | 'two-way'; keyword?: string; offset?: number; limit?: number; version?: string }, signal?: AbortSignal): Promise<{ items: Stored[]; total: number; offset: number; nextOffset: number | null; version: string }> {
    return this.run(async () => {
      const personId = uuid.parse(input.personId)
      const offset = z.number().int().nonnegative().parse(input.offset ?? 0)
      const limit = z.number().int().min(1).max(100).parse(input.limit ?? 50)
      const direction = z.enum(['outgoing', 'incoming', 'two-way']).optional().parse(input.direction)
      const keyword = z.string().trim().min(1).optional().parse(input.keyword)
      const all = await this.scan(signal)
      const matches = all.filter(({ document }) => {
        const side = document.participants.findIndex(participant => participant.kind === 'linked' && participant.id === personId)
        if (side < 0) return false
        if (!direction && !keyword) return true
        return document.relations.some(relation => {
          const relative = relation.direction === 'two-way' ? 'two-way' : (relation.direction === 'a-to-b') === (side === 0) ? 'outgoing' : 'incoming'
          return (!direction || relative === direction) && (!keyword || `${relation.name}\n${relation.description}`.includes(keyword))
        })
      })
      const version = digest(JSON.stringify(matches.map(item => [item.document.id, item.version])))
      if (input.version !== undefined && input.version !== version) throw new Error('人物关系查询结果已变化，请重新查询')
      signal?.throwIfAborted()
      const items = matches.slice(offset, offset + limit)
      return { items, total: matches.length, offset, nextOffset: offset + items.length < matches.length ? offset + items.length : null, version }
    })
  }
  /** 更新初始化方案；旧摘要、确认状态和配对冲突均拒绝覆盖。 */
  update(id: string, version: string, content: Content, signal?: AbortSignal): Promise<Stored> {
    return this.run(async () => {
      const all = await this.scan(signal); const old = all.find(value => value.document.id === id)
      if (!old) throw new Error('人物关系不存在')
      if (old.version !== version) throw new Error('人物关系版本已变化')
      if (old.document.contentStatus !== 'suggested') throw new Error('已确认关系不能直接覆盖')
      const oldIds = new Set(old.document.relations.map(item => item.id))
      if (content.relations.some(item => item.id !== undefined && !oldIds.has(item.id))) throw new Error('新关系条目不能指定 ID')
      const document = characterRelationshipSchema.parse({ ...old.document, ...content,
        relations: content.relations.map(item => ({ ...item, id: item.id ?? randomUUID() })) })
      this.validateParticipants(old.document, document)
      await this.verify(document, all, signal); signal?.throwIfAborted()
      const text = formatCharacterRelationship(document); if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('人物关系文件超过大小限制')
      const path = this.path(id); const temp = `${path}.${randomUUID()}.tmp`
      await writeFile(temp, text, { flag: 'wx' })
      try {
        signal?.throwIfAborted()
        if ((await this.readFile(id)).version !== version) throw new Error('人物关系版本已变化')
        try { await rename(temp, path) } catch (error) { throw new CharacterRelationshipCommitUnknownError(`${id}.json`, error) }
      } catch (error) { await rm(temp, { force: true }); throw error }
      return { document, version: digest(text), path: `${id}.json` }
    })
  }
}
