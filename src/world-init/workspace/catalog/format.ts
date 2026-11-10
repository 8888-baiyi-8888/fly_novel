import { lstat, open, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { parseDocument } from 'yaml'
import { z } from 'zod'
import { isPathUnder } from '@fly-novel/fs-sandbox'
import { validateWorldWorkspaceConfigs, type WorldWorkspaceConfig } from '../config.js'

const identity = z.string().min(1).refine(value => value.trim() === value, '身份首尾不能有空白')
const relativePath = z.string().min(1).refine(value =>
  !value.includes('\\') && !value.includes('\0') && !value.includes(':') &&
  value.split('/').every(part => part !== '' && part !== '.' && part !== '..'), '资料路径必须是规范的世界相对路径')
const recordSchema = z.object({
  path: relativePath,
  ownerAgentId: identity,
  summary: z.string().refine(value => value.trim().length > 0, '简介不能为空'),
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  revision: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
}).strict()
const documentSchema = z.object({ formatVersion: z.literal(1), worldId: identity, records: z.array(recordSchema) }).strict().superRefine((document, ctx) => {
  const paths = document.records.map(record => process.platform === 'win32' ? record.path.toLowerCase() : record.path)
  if (new Set(paths).size !== paths.length) ctx.addIssue({ code: 'custom', message: '资料路径重复' })
})

export type CatalogRecord = z.infer<typeof recordSchema>
export type CatalogDocument = z.infer<typeof documentSchema>

/** 校验持久化路径的语法；此检查不访问文件或授予权限。 */
export function validateCatalogRelativePath(path: string): string { return relativePath.parse(path) }

/** 解析版本化目录；拒绝无效 JSON、重复字段、未知版本及世界不匹配。 */
export function parseCatalogDocument(text: string, worldId: string): CatalogDocument {
  const data: unknown = JSON.parse(text)
  const parsed = parseDocument(text, { uniqueKeys: true })
  if (parsed.errors.length) throw new Error('资料目录包含重复或无效字段', { cause: parsed.errors[0] })
  const result = documentSchema.parse(data)
  if (result.worldId !== identity.parse(worldId)) throw new Error('资料目录世界身份不匹配')
  return result
}

/** 校验并序列化目录；成果文件是否存在由调用者另行检查。 */
export function formatCatalogDocument(document: CatalogDocument): string {
  return JSON.stringify(documentSchema.parse(document), null, 2) + '\n'
}

async function catalogFile(root: string): Promise<string> {
  if (!isAbsolute(root)) throw new Error('资料目录根必须是绝对路径')
  const physical = await realpath(root)
  if (physical !== resolve(root) || !(await stat(physical)).isDirectory()) throw new Error('资料目录根必须是现有真实目录')
  return join(physical, 'catalog.json')
}

/** 显式创建新目录文件；若目标已存在则拒绝，不创建目录。 */
export async function initializeCatalog(root: string, worldId: string): Promise<void> {
  const file = await catalogFile(root)
  await writeFile(file, formatCatalogDocument({ formatVersion: 1, worldId: identity.parse(worldId), records: [] }), { flag: 'wx' })
}

/** 读取并校验已有目录及可解析成果的别名；不会自动创建或修复数据。 */
export async function readCatalog(config: WorldWorkspaceConfig, maxBytes?: number): Promise<CatalogDocument> {
  const [world] = await validateWorldWorkspaceConfigs([config])
  if (!world) throw new Error('世界配置无效')
  const file = await catalogFile(world.catalogRoot)
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('资料目录文件必须是普通文件')
  let bytes: Uint8Array
  if (maxBytes === undefined) bytes = await readFile(file)
  else {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('目录文件大小上限无效')
    const handle = await open(file, 'r')
    try {
      const chunks: Buffer[] = []
      let length = 0
      for (;;) {
        const chunk = Buffer.alloc(Math.min(65536, maxBytes - length + 1))
        const result = await handle.read(chunk, 0, chunk.length, null)
        if (!result.bytesRead) break
        length += result.bytesRead
        if (length > maxBytes) throw new Error('目录文件超过大小上限')
        chunks.push(chunk.subarray(0, result.bytesRead))
      }
      bytes = Buffer.concat(chunks, length)
    } finally { await handle.close() }
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const document = parseCatalogDocument(text, world.worldId)
  const seen = new Set<string>()
  for (const record of document.records) {
    const owner = [world.mainAgent, ...world.agents].find(agent => agent.agentId === record.ownerAgentId)
    if (!owner) continue
    const requested = resolve(world.readRoot, ...record.path.split('/'))
    if (!await isPathUnder(requested, owner.writableRoot)) continue
    let actual: string
    try { actual = await realpath(requested) } catch (error) {
      if (error instanceof Error && 'code' in error && ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(String(error.code))) continue
      throw error
    }
    if (!await isPathUnder(actual, owner.writableRoot)) continue
    const key = process.platform === 'win32' ? actual.toLowerCase() : actual
    if (seen.has(key)) throw new Error('资料目录包含重复目标')
    seen.add(key)
  }
  return document
}
