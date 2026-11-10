import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import { characterMetadataSchema, formatCharacterDocument, formatRequirementsDocument, parseCharacterDocument, parseRequirementsDocument, type CharacterDocument, type CharacterMetadata, type Requirements } from './format.js'

const idSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
const indexSchema = z.object({ formatVersion: z.literal(1), characters: z.array(characterMetadataSchema) }).strict().superRefine((index, context) => {
  if (new Set(index.characters.map(item => item.id)).size !== index.characters.length || index.characters.some(item => item.contentStatus === 'pending')) {
    context.addIssue({ code: 'custom', message: '角色索引包含重复 ID 或待审资料' })
  }
})
const operationSchema = z.object({ formatVersion: z.literal(1), id: idSchema, baseline: z.string().regex(/^[0-9a-f]{64}$/),
  candidate: z.string().regex(/^[0-9a-f]{64}$/), phase: z.enum(['prepared', 'backup-ready', 'profile-written', 'index-written']) }).strict()
const pendingSchema = z.object({ formatVersion: z.literal(1), baseline: z.string().regex(/^[0-9a-f]{64}$/) }).strict()
const occupied = new Set<string>()
const digest = (text: string) => createHash('sha256').update(text).digest('hex')

async function regularFile(path: string): Promise<string> {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('角色资料必须是普通文件')
  return new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path))
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`
  await writeFile(temp, content, { flag: 'wx' })
  try { await rename(temp, path) } catch (error) { await rm(temp, { force: true }); throw error }
}

/** 单个可信应用拥有的角色资料根；调用方负责阻止其他进程同时写入。 */
export class CharacterStore {
  private tail: Promise<void> = Promise.resolve()
  private closed = false
  private constructor(private readonly root: string) {}

  /** 打开现有真实目录；空目录可显式初始化，非空目录不会自动创建索引。 */
  static async open(root: string, initialize = false, recovery = false): Promise<CharacterStore> {
    if (!isAbsolute(root) || await realpath(root) !== resolve(root) || !(await lstat(root)).isDirectory()) throw new Error('角色根必须是现有真实绝对目录')
    if (occupied.has(root)) throw new Error('角色根已被当前进程打开')
    occupied.add(root)
    try {
      if (initialize) {
        if ((await readdir(root)).length !== 0) throw new Error('只能初始化空角色根')
        await writeFile(join(root, 'index.json'), JSON.stringify({ formatVersion: 1, characters: [] }) + '\n', { flag: 'wx' })
      }
      const store = new CharacterStore(root)
      if (!recovery) await store.loadIndex()
      return store
    } catch (error) { occupied.delete(root); throw error }
  }

  private run<T>(action: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('角色资料服务已关闭'))
    const result = this.tail.then(action)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }

  /** 等待已提交操作结束并释放当前进程内的根目录占用。 */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.tail
    occupied.delete(this.root)
  }

  private async directory(id: string): Promise<string> {
    idSchema.parse(id)
    const dir = join(this.root, id)
    const info = await lstat(dir)
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(dir) !== dir) throw new Error('角色目录无效')
    return dir
  }

  private async loadIndex(): Promise<z.infer<typeof indexSchema>> {
    const index = indexSchema.parse(JSON.parse(await regularFile(join(this.root, 'index.json'))))
    for (const item of index.characters) {
      const dir = await this.directory(item.id)
      try { await lstat(join(dir, 'operation.json')); throw new Error('角色存在未完成的提交') } catch (error) { if (!missing(error)) throw error }
      const actual = parseCharacterDocument(await regularFile(join(dir, 'profile.md'))).metadata
      if (JSON.stringify(actual) !== JSON.stringify(item)) throw new Error('角色索引与资料不一致')
    }
    const entries = await readdir(this.root, { withFileTypes: true })
    const ids = entries.filter(entry => idSchema.safeParse(entry.name).success).map(entry => entry.name)
    if (ids.length !== index.characters.length || ids.some(id => !index.characters.some(item => item.id === id))) throw new Error('角色索引不完整')
    return index
  }

  private async saveIndex(characters: CharacterMetadata[]): Promise<void> {
    const value = indexSchema.parse({ formatVersion: 1, characters: characters.sort((a, b) => a.id.localeCompare(b.id)) })
    await writeAtomic(join(this.root, 'index.json'), JSON.stringify(value, null, 2) + '\n')
  }

  /** 创建建议角色，ID 由服务生成；索引写入失败保留资料并明确报错。 */
  create(input: Omit<CharacterMetadata, 'formatVersion' | 'id' | 'contentStatus'> & { body: string }): Promise<CharacterMetadata> {
    return this.run(async () => {
      const index = await this.loadIndex()
      const { body, ...fields } = input
      characterMetadataSchema.parse({ ...fields, formatVersion: 1, id: randomUUID(), contentStatus: 'suggested' })
      let id: string
      let dir: string
      for (;;) {
        id = randomUUID(); dir = join(this.root, id)
        try { await mkdir(dir); break } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error }
      }
      const metadata = characterMetadataSchema.parse({ ...fields, formatVersion: 1, id, contentStatus: 'suggested' })
      await writeFile(join(dir, 'profile.md'), formatCharacterDocument({ metadata, body }), { flag: 'wx' })
      await this.saveIndex([...index.characters, metadata])
      return metadata
    })
  }

  /** 按名称或分类精确查询；不同维度取交集，同维度类别取并集。 */
  query(input: { name?: string; categories?: Record<string, string[]> }): Promise<CharacterMetadata[]> {
    return this.run(async () => (await this.loadIndex()).characters.filter(item =>
      (input.name === undefined || item.name === input.name.trim()) && Object.entries(input.categories ?? {}).every(([key, values]) =>
        values.some(value => item.categories[key]?.some(entry => entry.id === value)))))
  }

  /** 按角色 ID 读取当前资料；候选不混入当前视图。 */
  read(id: string): Promise<CharacterDocument> {
    return this.run(async () => {
      const index = await this.loadIndex()
      if (!index.characters.some(item => item.id === id)) throw new Error('角色不存在')
      return parseCharacterDocument(await regularFile(join(await this.directory(id), 'profile.md')))
    })
  }

  /** 批量读取逐项返回结果；失败项不会伪装为不存在或完整成功。 */
  readMany(ids: string[]): Promise<Array<{ id: string; document: CharacterDocument } | { id: string; error: string }>> {
    return this.run(async () => {
      const index = await this.loadIndex()
      const results: Array<{ id: string; document: CharacterDocument } | { id: string; error: string }> = []
      for (const id of ids) {
        try {
          if (!index.characters.some(item => item.id === id)) throw new Error('角色不存在')
          results.push({ id, document: parseCharacterDocument(await regularFile(join(await this.directory(id), 'profile.md'))) })
        } catch (error) {
          results.push({ id, error: error instanceof Error ? error.message : '读取失败' })
        }
      }
      return results
    })
  }

  /** 保存候选并返回原资料与候选的摘要，供可信确认绑定。 */
  prepare(id: string, input: Omit<CharacterMetadata, 'formatVersion' | 'id' | 'contentStatus'> & { body: string }): Promise<{ baseline: string; candidate: string }> {
    return this.run(async () => {
      const index = await this.loadIndex()
      if (!index.characters.some(item => item.id === id)) throw new Error('角色不存在')
      const dir = await this.directory(id)
      const baseline = digest(await regularFile(join(dir, 'profile.md')))
      const { body, ...fields } = input
      const metadata = characterMetadataSchema.parse({ ...fields, formatVersion: 1, id, contentStatus: 'pending' })
      const candidate = formatCharacterDocument({ metadata, body })
      const statePath = join(dir, 'pending.json')
      try {
        const state = pendingSchema.parse(JSON.parse(await regularFile(statePath)))
        if (state.baseline !== baseline) throw new Error('角色资料在修改期间已变化')
      } catch (error) {
        if (!missing(error)) throw error
        await writeFile(statePath, JSON.stringify({ formatVersion: 1, baseline }) + '\n', { flag: 'wx' })
      }
      await writeAtomic(join(dir, 'pending.md'), candidate)
      return { baseline, candidate: digest(candidate) }
    })
  }

  /** 读取已保存候选及其原资料基线，便于重新实例化后继续讨论。 */
  readPending(id: string): Promise<{ document: CharacterDocument; baseline: string; candidate: string }> {
    return this.run(async () => {
      await this.loadIndex()
      const dir = await this.directory(id)
      const state = pendingSchema.parse(JSON.parse(await regularFile(join(dir, 'pending.json'))))
      const text = await regularFile(join(dir, 'pending.md'))
      const document = parseCharacterDocument(text)
      if (document.metadata.id !== id || document.metadata.contentStatus !== 'pending') throw new Error('待审角色资料无效')
      return { document, baseline: state.baseline, candidate: digest(text) }
    })
  }

  /** 可信应用在完成确认后调用；摘要不一致时拒绝提交。 */
  commit(id: string, confirmation: { baseline: string; candidate: string }): Promise<void> {
    return this.run(async () => {
      const index = await this.loadIndex()
      const dir = await this.directory(id)
      const profile = await regularFile(join(dir, 'profile.md'))
      const pending = await regularFile(join(dir, 'pending.md'))
      const pendingState = pendingSchema.parse(JSON.parse(await regularFile(join(dir, 'pending.json'))))
      if (pendingState.baseline !== confirmation.baseline) throw new Error('待审修改基线不匹配')
      if (digest(profile) !== confirmation.baseline || digest(pending) !== confirmation.candidate) throw new Error('角色资料或候选已变化')
      const parsed = parseCharacterDocument(pending)
      if (parsed.metadata.id !== id || parsed.metadata.contentStatus !== 'pending') throw new Error('待审角色资料无效')
      try { await lstat(join(dir, 'backup.md')); throw new Error('已有备份尚未处理') } catch (error) { if (!missing(error)) throw error }
      const metadata = { ...parsed.metadata, contentStatus: 'confirmed' as const }
      const committed = formatCharacterDocument({ ...parsed, metadata })
      const operation = { formatVersion: 1, id, baseline: digest(profile), candidate: digest(committed), phase: 'prepared' as const }
      const operationPath = join(dir, 'operation.json')
      await writeFile(operationPath, JSON.stringify(operation) + '\n', { flag: 'wx' })
      await writeFile(join(dir, 'backup.md'), profile, { flag: 'wx' })
      await writeAtomic(operationPath, JSON.stringify({ ...operation, phase: 'backup-ready' }) + '\n')
      await writeAtomic(join(dir, 'profile.md'), committed)
      await writeAtomic(operationPath, JSON.stringify({ ...operation, phase: 'profile-written' }) + '\n')
      await this.saveIndex(index.characters.map(item => item.id === id ? metadata : item))
      await writeAtomic(operationPath, JSON.stringify({ ...operation, phase: 'index-written' }) + '\n')
      await rm(join(dir, 'operation.json'))
      await rm(join(dir, 'pending.md'))
      await rm(join(dir, 'pending.json'))
      await rm(join(dir, 'backup.md'))
    })
  }

  /** 基于已记录摘要检查中断状态；不会覆盖无法识别的文件。 */
  recover(id: string): Promise<'retry' | 'completed'> {
    return this.run(async () => {
      const dir = await this.directory(id)
      const operation = operationSchema.parse(JSON.parse(await regularFile(join(dir, 'operation.json'))))
      if (operation.id !== id) throw new Error('恢复记录身份不一致')
      const profile = await regularFile(join(dir, 'profile.md'))
      if (digest(profile) === operation.baseline) {
        try {
          const backup = await regularFile(join(dir, 'backup.md'))
          if (digest(backup) !== operation.baseline) throw new Error('备份与基线不一致')
          await rm(join(dir, 'backup.md'))
        } catch (error) { if (!missing(error)) throw error }
        await rm(join(dir, 'operation.json'))
        return 'retry'
      }
      if (digest(profile) !== operation.candidate || digest(await regularFile(join(dir, 'backup.md'))) !== operation.baseline) throw new Error('恢复文件与记录不一致')
      await this.assertIndexVersion()
      await this.rebuildIndexInternal()
      await rm(join(dir, 'operation.json'))
      await rm(join(dir, 'pending.md'), { force: true })
      await rm(join(dir, 'pending.json'), { force: true })
      await rm(join(dir, 'backup.md'))
      return 'completed'
    })
  }

  private async rebuildIndexInternal(): Promise<void> {
    const ids = (await readdir(this.root)).filter(name => idSchema.safeParse(name).success)
    const characters: CharacterMetadata[] = []
    for (const id of ids) {
      const metadata = parseCharacterDocument(await regularFile(join(await this.directory(id), 'profile.md'))).metadata
      if (metadata.id !== id || metadata.contentStatus === 'pending') throw new Error('角色资料身份或状态无效')
      characters.push(metadata)
    }
    await this.saveIndex(characters)
  }

  private async assertIndexVersion(): Promise<void> {
    try {
      const text = await regularFile(join(this.root, 'index.json'))
      let index: unknown
      try { index = JSON.parse(text) } catch (error) { if (!(error instanceof SyntaxError)) throw error }
      if (index && typeof index === 'object' && 'formatVersion' in index && index.formatVersion !== 1) throw new Error('不能重建未知版本的角色索引')
    } catch (error) { if (!missing(error)) throw error }
  }

  /** 从全部有效角色资料重建索引；不覆盖未知版本或未完成的提交。 */
  rebuildIndex(): Promise<void> {
    return this.run(async () => {
      await this.assertIndexVersion()
      for (const name of await readdir(this.root)) {
        if (!idSchema.safeParse(name).success) continue
        try { await lstat(join(await this.directory(name), 'operation.json')); throw new Error('角色存在未完成的提交') } catch (error) { if (!missing(error)) throw error }
      }
      try {
        const previous = await regularFile(join(this.root, 'index.json'))
        await writeFile(join(this.root, `index.rebuild-${randomUUID()}.bak`), previous, { flag: 'wx' })
      } catch (error) { if (!missing(error)) throw error }
      await this.rebuildIndexInternal()
    })
  }

  /** 保存版本化需求清单，版本校验由调用方传入读取时的摘要。 */
  saveRequirements(data: Requirements, body: string, expected?: string): Promise<string> {
    return this.run(async () => {
      const path = join(this.root, 'requirements.md')
      if (expected !== undefined) {
        const previous = await regularFile(path)
        parseRequirementsDocument(previous)
        if (digest(previous) !== expected) throw new Error('需求清单已变化')
      }
      const text = formatRequirementsDocument(data, body)
      if (expected === undefined) await writeFile(path, text, { flag: 'wx' })
      else await writeAtomic(path, text)
      return digest(text)
    })
  }

  /** 读取需求清单及版本摘要。 */
  readRequirements(): Promise<{ data: Requirements; body: string; version: string }> {
    return this.run(async () => {
      const text = await regularFile(join(this.root, 'requirements.md'))
      return { ...parseRequirementsDocument(text), version: digest(text) }
    })
  }
}
