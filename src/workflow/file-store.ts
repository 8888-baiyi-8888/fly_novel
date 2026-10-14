import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { NovelId } from '../novel/types'
import type { PersistedWorkflow, WorkflowStore } from './types.ts'

/**
 * JsonFileStore：WorkflowStore 的 JSON 文件实现（断点续跑落地）。
 * 布局：{dir}/{chapter}.json，内容 = PersistedWorkflow（state + artifacts）。
 * 写入：先落 {chapter}.json.tmp 再 rename（原子替换，避免半写文件）；
 * load 遇 ENOENT 返回 undefined（该章尚未开始）；JSON 损坏 → 抛错（不静默吞）。
 * 真实存储（数据库/云盘）就绪后替换本实现，引擎零改动。
 */
export interface JsonFileStoreOptions {
  /** 根目录（自动创建）。 */
  readonly dir: string
}

export function createJsonFileStore(options: JsonFileStoreOptions): WorkflowStore {
  const { dir } = options
  const fileOf = (_novelId: NovelId, chapter: number): string => join(dir, `${chapter}.json`)

  async function migrateLegacyChapter(novelId: NovelId, chapter: number): Promise<PersistedWorkflow | undefined> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    const legacyFiles = entries.filter((entry) => entry.isDirectory()).map((entry) => join(dir, entry.name, `${chapter}.json`))
    const matches: string[] = []
    for (const path of legacyFiles) {
      try {
        await readFile(path, 'utf8')
        matches.push(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    if (matches.length === 0) return undefined
    if (matches.length > 1) throw new Error(`第 ${chapter} 章存在多份旧断点，无法确定要迁移的文件`)

    const previous = JSON.parse(await readFile(matches[0], 'utf8')) as Record<string, unknown>
    const migrateKeys = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(migrateKeys)
      if (typeof value !== 'object' || value === null) return value
      const migrated: Record<string, unknown> = {}
      for (const [key, child] of Object.entries(value)) {
        migrated[key === 'bookId' ? 'novelId' : key] = migrateKeys(child)
      }
      return migrated
    }
    const migrated = migrateKeys(previous) as PersistedWorkflow
    const record = { ...migrated, novelId, state: { ...migrated.state, novelId } }
    const file = fileOf(novelId, chapter)
    const tmp = `${file}.tmp`
    await writeFile(tmp, JSON.stringify(record, null, 2), 'utf8')
    await rename(tmp, file)
    return record
  }

  return {
    async load(novelId, chapter) {
      try {
        const raw = await readFile(fileOf(novelId, chapter), 'utf8')
        const record = JSON.parse(raw) as PersistedWorkflow
        if (record.novelId !== novelId || record.chapter !== chapter) return undefined
        return record
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return migrateLegacyChapter(novelId, chapter)
        throw error
      }
    },
    async save(record) {
      const file = fileOf(record.novelId, record.chapter)
      await mkdir(dirname(file), { recursive: true })
      try {
        const existing = JSON.parse(await readFile(file, 'utf8')) as PersistedWorkflow
        if (existing.novelId !== record.novelId) {
          throw new Error(`章节文件 ${file} 已属于另一个 novelId`)
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      const tmp = `${file}.tmp`
      await writeFile(tmp, JSON.stringify(record, null, 2), 'utf8')
      await rename(tmp, file)
    },
  }
}
