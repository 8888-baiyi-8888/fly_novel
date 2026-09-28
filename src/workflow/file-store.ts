import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { BookId } from '../novel/types'
import type { PersistedWorkflow, WorkflowStore } from './types.ts'

/**
 * JsonFileStore：WorkflowStore 的 JSON 文件实现（断点续跑落地）。
 * 布局：{dir}/{bookId}/{chapter}.json，内容 = PersistedWorkflow（state + artifacts）。
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
  const fileOf = (bookId: BookId, chapter: number): string => join(dir, String(bookId), `${chapter}.json`)

  return {
    async load(bookId, chapter) {
      try {
        const raw = await readFile(fileOf(bookId, chapter), 'utf8')
        return JSON.parse(raw) as PersistedWorkflow
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      }
    },
    async save(record) {
      const file = fileOf(record.bookId, record.chapter)
      await mkdir(dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      await writeFile(tmp, JSON.stringify(record, null, 2), 'utf8')
      await rename(tmp, file)
    },
  }
}
