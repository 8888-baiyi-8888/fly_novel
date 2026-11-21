import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { parseDocument } from 'yaml'
import { z } from 'zod'
import { isPathUnder } from '@fly-novel/fs-sandbox'
import type { SessionPersistence } from '@fly-novel/session-persistence'
import { candidateSchema, discussionSchema } from '../discussion/service.js'
import { impactReportSchema } from '../impact/service.js'
import { confirmationSchema, reviewSchema, validateReview } from '../impact/review.js'
import { operationSchema } from '../impact/commit.js'
import { batchSchema, validateBatch } from '../impact/batch-commit.js'
import { validateWorldWorkspaceConfigs, type WorldWorkspaceConfig } from '../workspace/config.js'

const schemas = { discussion: discussionSchema, candidate: candidateSchema, impact: impactReportSchema,
  review: reviewSchema, confirmation: confirmationSchema, commit: operationSchema, batch: batchSchema } as const
export type DiscoveryKind = keyof typeof schemas
export type DiscoveryRoot = 'discussion' | 'impact' | 'review' | 'commit' | 'batch'
export interface DiscoveryEntry {
  readonly kind: DiscoveryKind
  readonly name: string
  readonly status: 'valid' | 'invalid' | 'unsupported-version' | 'unreadable' | 'changed'
  readonly version?: string
  readonly record?: unknown
  readonly error?: string
}
export interface DiscoveryScope {
  readonly kind: DiscoveryKind
  readonly status: 'complete' | 'partial' | 'unconfigured'
  readonly error?: string
}
export interface DiscoverySnapshot {
  readonly worldId: string
  readonly scopes: readonly DiscoveryScope[]
  readonly entries: readonly DiscoveryEntry[]
  readonly issues: readonly string[]
  readonly sessions: { readonly status: 'available' | 'unconfigured' | 'failed'; readonly ids: readonly string[]; readonly error?: string }
  readonly limitations: readonly string[]
}

const directories: readonly { kind: DiscoveryKind; root: DiscoveryRoot; subdir?: string }[] = [
  { kind: 'discussion', root: 'discussion', subdir: 'discussions' }, { kind: 'candidate', root: 'discussion', subdir: 'candidates' },
  { kind: 'impact', root: 'impact' }, { kind: 'review', root: 'review', subdir: 'reviews' },
  { kind: 'confirmation', root: 'review', subdir: 'confirmations' }, { kind: 'commit', root: 'commit' }, { kind: 'batch', root: 'batch' },
]
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 1000)
const digest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')
const idSchema = z.string().uuid()

/** 只读扫描可信配置的现有业务根；结果不是跨文件事务，也不表示 Session 对业务状态的证明。 */
export async function discoverInitialization(options: {
  readonly worlds: readonly WorldWorkspaceConfig[]
  readonly worldId: string
  readonly roots: Partial<Record<DiscoveryRoot, string>>
  readonly sessionRoots: readonly string[]
  readonly sessions?: SessionPersistence
}): Promise<DiscoverySnapshot> {
  const worlds = await validateWorldWorkspaceConfigs(options.worlds)
  if (!worlds.some(world => world.worldId === options.worldId)) throw new Error('未找到可信世界身份')
  const roots = Object.values(options.roots)
  for (const root of [...roots, ...options.sessionRoots]) {
    if (!root || !isAbsolute(root) || await realpath(root) !== resolve(root) || !(await lstat(root)).isDirectory()) throw new Error('记录根必须是现有真实绝对目录')
  }
  const isolated = [...roots, ...options.sessionRoots]
  for (let i = 0; i < isolated.length; i++) {
    for (const world of worlds) if (await isPathUnder(isolated[i]!, world.readRoot) || await isPathUnder(world.readRoot, isolated[i]!)) throw new Error('记录根不能与世界读取根重叠')
    for (let j = i + 1; j < isolated.length; j++) if (await isPathUnder(isolated[i]!, isolated[j]!) || await isPathUnder(isolated[j]!, isolated[i]!)) throw new Error('记录根不能相互重叠')
  }
  const entries: DiscoveryEntry[] = []
  const scopes: DiscoveryScope[] = []
  for (const spec of directories) {
    const root = options.roots[spec.root]
    if (!root) { scopes.push({ kind: spec.kind, status: 'unconfigured' }); continue }
    const folder = spec.subdir ? join(root, spec.subdir) : root
    let names: string[]
    try {
      const info = await lstat(folder)
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(folder) !== folder) throw new Error('记录目录不是现有真实目录')
      names = (await readdir(folder)).sort()
      if (names.length > 10000) throw new Error('记录数量超过单次发现上限')
    } catch (error) { scopes.push({ kind: spec.kind, status: 'partial', error: errorText(error) }); continue }
    let partial = false
    for (const name of names) {
      // 不忽略目录内无法识别的文件，以免把未知数据当成空记录。
      const entry: { kind: DiscoveryKind; name: string; status: DiscoveryEntry['status']; version?: string; record?: unknown; error?: string } = { kind: spec.kind, name, status: 'invalid' }
      entries.push(entry)
      const id = name.endsWith('.json') ? name.slice(0, -5) : ''
      if (!idSchema.safeParse(id).success || name !== `${id}.json`) { entry.error = '无法识别的记录名称'; partial = true; continue }
      try {
        const path = join(folder, name)
        const before = await lstat(path)
        if (!before.isFile() || before.isSymbolicLink()) throw new Error('记录不是普通文件')
        if (before.size > 16 * 1024 * 1024) throw new Error('记录超过读取上限')
        const bytes = await readFile(path)
        const after = await lstat(path)
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino || bytes.length !== after.size) { entry.status = 'changed'; entry.error = '读取期间记录发生变化'; partial = true; continue }
        entry.version = digest(bytes)
        let value: unknown
        try {
          const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
          const doc = parseDocument(text, { uniqueKeys: true })
          if (doc.errors.length) throw new Error('记录存在语法错误或重复字段')
          value = JSON.parse(text) as unknown
        } catch (error) { entry.error = errorText(error); partial = true; continue }
        if (typeof value === 'object' && value !== null && 'formatVersion' in value) {
          const version = value.formatVersion
          if (version !== 1 && !(spec.kind === 'candidate' && version === 2)) { entry.status = 'unsupported-version'; entry.error = '记录格式版本不支持'; partial = true; continue }
        }
        const parsed = schemas[spec.kind].safeParse(value)
        if (!parsed.success) { entry.error = '记录格式无效'; partial = true; continue }
        const record = parsed.data
        const recordId = 'id' in record ? record.id : record.reviewId
        if (record.worldId !== options.worldId || recordId !== id) { entry.error = '记录世界或身份不匹配'; partial = true; continue }
        try {
          if (spec.kind === 'review') validateReview(reviewSchema.parse(record))
          if (spec.kind === 'batch') validateBatch(batchSchema.parse(record))
        } catch (error) { entry.error = errorText(error); partial = true; continue }
        entry.status = 'valid'; entry.record = record
      } catch (error) { entry.status = 'unreadable'; entry.error = errorText(error); partial = true }
    }
    scopes.push({ kind: spec.kind, status: partial ? 'partial' : 'complete' })
  }
  let sessions: DiscoverySnapshot['sessions'] = { status: 'unconfigured', ids: [] }
  if (options.sessions) {
    try { sessions = { status: 'available', ids: (await options.sessions.list()).map(item => item.header.id).sort() } }
    catch (error) { sessions = { status: 'failed', ids: [], error: errorText(error) } }
  }
  const issues: string[] = []
  const records = (kind: DiscoveryKind) => entries.filter(entry => entry.kind === kind && entry.status === 'valid').map(entry => entry.record)
  const discussions = records('discussion').map(value => discussionSchema.parse(value))
  const candidates = records('candidate').map(value => candidateSchema.parse(value))
  if (scopes.find(scope => scope.kind === 'discussion')?.status === 'complete') {
    for (const candidate of candidates) {
      const discussion = discussions.find(item => item.id === candidate.discussionId)
      if (!discussion) issues.push(`候选 ${candidate.id} 未找到所属讨论`)
      else if (JSON.stringify(discussion.target) !== JSON.stringify(candidate.target)) issues.push(`候选 ${candidate.id} 与所属讨论目标不同`)
    }
  }
  if (sessions.status === 'available') for (const discussion of discussions) if (!sessions.ids.includes(discussion.sessionId)) issues.push(`讨论 ${discussion.id} 的 Session 未找到`)
  if (scopes.find(scope => scope.kind === 'candidate')?.status === 'complete') for (const value of records('impact')) {
    const report = impactReportSchema.parse(value)
    const candidate = candidates.find(item => item.id === report.candidateId)
    if (!candidate) issues.push(`影响报告 ${report.id} 未找到所属候选`)
    else if (candidate.discussionId !== report.discussionId) issues.push(`影响报告 ${report.id} 与候选讨论身份不同`)
  }
  return { worldId: options.worldId, scopes, entries, sessions, issues,
    limitations: ['扫描不是跨文件事务；业务状态须在操作前重新核查。', 'Session 列表未证明其属于所选世界，也不证明任务完成。', '未扫描旧模块候选、人物索引及世界正文。'] }
}

/** 对完整扫描结果分页；续页必须使用同一快照摘要，变化后应从头重新扫描。 */
export function pageDiscovery(snapshot: DiscoverySnapshot, options: { readonly offset?: number; readonly limit?: number; readonly version?: string } = {}) {
  const offset = options.offset ?? 0
  const limit = options.limit ?? 50
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('发现分页参数无效')
  const version = digest(JSON.stringify(snapshot))
  if ((offset > 0 && !options.version) || (options.version !== undefined && options.version !== version)) throw new Error('发现结果已变化或缺少分页版本')
  if (offset > snapshot.entries.length) throw new Error('发现分页起点越界')
  const entries = snapshot.entries.slice(offset, offset + limit)
  const nextOffset = offset + entries.length < snapshot.entries.length ? offset + entries.length : null
  return { version, entries, nextOffset, scopes: snapshot.scopes, sessions: snapshot.sessions, issues: snapshot.issues, limitations: snapshot.limitations }
}
