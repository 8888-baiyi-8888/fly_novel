import { createHash } from 'node:crypto'
import { lstat, open, readFile, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { jsonlSessionPersistencePlugin } from '@fly-novel/agents'
import { CharacterStore } from '@fly-novel/character'
import { parseDocument } from 'yaml'
import { taskSchema } from '../world-init/recovery/task-store.js'
import { mainSessionPersistenceId } from '../world-init/recovery/main-session-id.js'
import { readCatalog } from '../world-init/workspace/catalog/format.js'

export const sampleOwnerIds = ['basics', 'characters', 'map', 'organization', 'history', 'situation', 'development', 'specific'] as const
export type SampleOwner = typeof sampleOwnerIds[number]
const prefixes: Record<SampleOwner, string> = { basics: 'world-basics', characters: 'character-creator', map: 'map-agent', organization: 'organization-agent',
  history: 'history-agent', situation: 'initial-situation-agent', development: 'world-development-agent', specific: 'world-specific-agent' }

/** 样例使用固定的负责人目录；身份最终由已有任务和资料目录交叉校验。 */
export function sampleWorld(root: string, worldId: string) {
  const view = join(root, 'world')
  return { worldId, readRoot: view, confirmedRoot: join(view, 'confirmed'), catalogRoot: join(view, 'catalog'),
    mainAgent: { agentId: 'main', writableRoot: join(view, 'main') }, agents: sampleOwnerIds.map(agentId => ({ agentId, writableRoot: join(view, agentId) })) }
}
export function sampleRoots(root: string) {
  return { task: join(root, 'task'), discussion: join(root, 'discussion'), impact: join(root, 'impact'), review: join(root, 'review'),
    commit: join(root, 'commit'), batch: join(root, 'batch'), delivery: join(root, 'delivery') }
}

async function existingDirectory(path: string) {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== resolve(path)) throw new Error('续跑目录必须是现有真实目录')
}
async function hasFiles(path: string): Promise<boolean> {
  await existingDirectory(path)
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('资料目录包含符号链接，需要人工核查')
    if (entry.isFile()) return true
    if (!entry.isDirectory()) throw new Error('资料目录包含无法识别的对象')
    if (await hasFiles(join(path, entry.name))) return true
  }
  return false
}
async function readTask(root: string) {
  const folder = join(root, 'task', 'tasks'); await existingDirectory(folder)
  const names = await readdir(folder)
  if (names.length !== 1 || !/^[0-9a-f-]{36}\.json$/.test(names[0]!)) throw new Error('样例目录必须有唯一可识别的任务记录')
  const path = join(folder, names[0]!); const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error('任务记录不是可读取的普通文件')
  const text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path))
  if (parseDocument(text, { uniqueKeys: true }).errors.length) throw new Error('任务记录格式无效')
  const task = taskSchema.parse(JSON.parse(text))
  if (`${task.id}.json` !== names[0] || !task.sessionIds.includes('initial') || !task.sessionIds.includes('overview-discussion')) throw new Error('任务身份或样例 Session 不匹配')
  return task
}

/** 只读核查样例中断现场；不创建目录、补造判断或恢复写入。 */
export async function inspectInitialSampleResume(path: string) {
  if (!isAbsolute(path)) throw new Error('续跑目录必须使用绝对路径')
  const root = resolve(path); await existingDirectory(root)
  const task = await readTask(root); const world = sampleWorld(root, task.worldId); const roots = sampleRoots(root)
  await readCatalog(world, 16 * 1024 * 1024)
  const hasJudgment = await hasFiles(join(root, 'task', 'first-versions'))
  if (!hasJudgment && await hasFiles(world.mainAgent.writableRoot)) throw new Error('主 Agent 目录已有成果或总览；不能自动判定第一版完整，也不能覆盖，请先核查')
  if (!hasJudgment) for (const folder of ['discussion/discussions', 'discussion/candidates', 'impact', 'review/reviews', 'review/confirmations', 'commit', 'batch', 'delivery/reviews', 'delivery/deliveries']) {
    if (await hasFiles(join(root, ...folder.split('/')))) throw new Error(`缺少第一版判断但已有 ${folder} 记录；请先核查`)
  }
  const sessionRoot = join(root, 'sessions'); await existingDirectory(sessionRoot)
  const context = new Context(); const backend = await context.plugin(jsonlSessionPersistencePlugin, { root: sessionRoot })
  const modes: Record<SampleOwner, 'create' | 'resume'> = { basics: 'create', characters: 'create', map: 'create', organization: 'create',
    history: 'create', situation: 'create', development: 'create', specific: 'create' }
  let discussionSessionExists = false
  try {
    const check = async (id: string) => {
      const dir = join(sessionRoot, `s-${Buffer.from(id, 'utf8').toString('base64url')}`)
      try {
        await existingDirectory(dir)
        const versions = (await readdir(dir)).flatMap(name => {
          const match = /^session\.v([1-9]\d*)\.jsonl$/.exec(name)
          return match ? [{ name, version: Number(match[1]) }] : []
        }).sort((a, b) => b.version - a.version)
        if (!versions.length) throw new Error('Session 目录缺少可识别的版本')
        const file = join(dir, versions[0]!.name); const info = await lstat(file)
        if (!info.isFile() || info.isSymbolicLink() || info.size === 0) throw new Error('Session 文件不完整')
        const handle = await open(file, 'r')
        try {
          const last = Buffer.alloc(1); await handle.read(last, 0, 1, info.size - 1)
          if (last[0] !== 10) throw new Error('Session 存在未完成的尾行；为保护原数据，停止续跑')
        } finally { await handle.close() }
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      }
      const snapshot = await context.sessionPersistence.stat(id)
      if (!snapshot) {
        try { await lstat(dir); throw new Error('Session 目录存在但无法读取，需要人工核查') }
        catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
      }
      return Boolean(snapshot)
    }
    if (!await check(mainSessionPersistenceId(world.worldId, 'main', 'initial', 'initialization'))) throw new Error('缺少原主 Agent Session，不能自动续跑')
    discussionSessionExists = await check(mainSessionPersistenceId(world.worldId, 'main', 'overview-discussion', 'discussion'))
    for (const owner of sampleOwnerIds) {
      const id = `${prefixes[owner]}-${createHash('sha256').update(JSON.stringify([world.worldId, owner, owner])).digest('hex')}`
      if (await check(id)) modes[owner] = 'resume'
    }
  } finally { await backend.dispose() }

  // 只允许没有现有成果且没有旧 Session 的专用 Agent 继续创建，避免盲目重复创建。
  const enabled = new Set<SampleOwner>()
  for (const owner of sampleOwnerIds.filter(item => item !== 'characters')) {
    if (modes[owner] === 'create' && !await hasFiles(join(world.readRoot, owner))) enabled.add(owner)
  }
  const characterRoot = join(world.readRoot, 'characters'); await existingDirectory(characterRoot)
  const characterEntries = await readdir(characterRoot)
  let initializeCharacters = false
  if (characterEntries.length === 0) { initializeCharacters = true; if (modes.characters === 'create') enabled.add('characters') }
  else if (characterEntries.includes('index.json')) {
    const store = await CharacterStore.open(characterRoot, false)
    try {
      const people = await store.query({})
      const extra = characterEntries.filter(name => !['index.json', 'relationships'].includes(name))
      const relationPath = join(characterRoot, 'relationships')
      const relationHasFiles = characterEntries.includes('relationships') ? await hasFiles(relationPath) : false
      if (people.length === 0 && extra.length === 0 && !relationHasFiles) enabled.add('characters')
    } finally { await store.close() }
  } else throw new Error('人物目录非空但缺少索引；不能重新初始化，请先核查')
  return { root, world, roots, task, modes, enabled, initializeCharacters, hasJudgment, discussionSessionExists }
}
