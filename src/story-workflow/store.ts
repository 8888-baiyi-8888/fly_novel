import { lstat, readFile, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { parseStrictJson, planRecordSchema, type PlanRecord } from './plan.js'

const uuid = z.string().uuid()
const key = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path
function within(parent: string, child: string): boolean {
  const rel = relative(key(parent), key(child))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** 独立规划记录：仅创建与读取，调用方保证列出所有需要隔离的业务根。 */
export class PlanStore {
  private constructor(private readonly root: string) {}

  /** 打开现有真实目录；禁止与调用方提供的受保护目录重叠。 */
  static async open(root: string, protectedRoots: readonly string[]): Promise<PlanStore> {
    async function directory(path: string): Promise<string> {
      if (!isAbsolute(path)) throw new Error('目录必须是绝对路径')
      const resolved = await realpath(path)
      if (key(resolved) !== key(resolve(path)) || !(await lstat(resolved)).isDirectory()) throw new Error('目录必须是现有真实目录')
      return resolved
    }
    const realRoot = await directory(root)
    for (const path of protectedRoots) {
      const protectedRoot = await directory(path)
      if (within(realRoot, protectedRoot) || within(protectedRoot, realRoot)) throw new Error('规划目录与受保护目录重叠')
    }
    return new PlanStore(realRoot)
  }

  private path(id: string): string { return join(this.root, `${uuid.parse(id)}.json`) }

  /** 独占创建记录；失败保留原文件，错误包含运行 ID 以便核查。 */
  async save(record: PlanRecord): Promise<void> {
    const value = planRecordSchema.parse(record)
    const content = `${JSON.stringify(value, null, 2)}\n`
    if (Buffer.byteLength(content) > 1024 * 1024) throw new Error('规划记录超过大小限制')
    try { await writeFile(this.path(value.id), content, { encoding: 'utf8', flag: 'wx' }) }
    catch (error) { throw new Error(`规划保存失败或结果不明，请核查运行 ${value.id}`, { cause: error }) }
  }

  /** 读取并校验规划身份、版本及 JSON；损坏文件不会被修改。 */
  async read(id: string): Promise<PlanRecord> {
    const path = this.path(id)
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || key(await realpath(path)) !== key(path)) throw new Error('规划记录必须是普通文件')
    if (info.size > 1024 * 1024) throw new Error('规划记录超过大小限制')
    const bytes = await readFile(path)
    if (bytes.length > 1024 * 1024) throw new Error('规划记录超过大小限制')
    const value = planRecordSchema.parse(parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
    if (value.id !== id) throw new Error('规划运行身份不匹配')
    return value
  }
}
