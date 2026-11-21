import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@fly-novel/fs-local'
import { WorldAccess } from '@fly-novel/util'
import type { DiscussionTargetAdapter } from '../discussion/service.js'
import { discoverInitialization } from '../recovery/discovery.js'
import { InitializationTaskStore } from '../recovery/task-store.js'

test('任务与第一版判断可重启复核，旧世界不自动产生判断', async t => {
  const temp = join(process.cwd(), 'tmp'); await mkdir(temp, { recursive: true })
  const root = await realpath(await mkdtemp(join(temp, 'init-task-'))); t.after(() => rm(root, { recursive: true, force: true }))
  for (const dir of ['world/main', 'world/confirmed', 'world/catalog', 'tasks/tasks', 'tasks/first-versions', 'session']) await mkdir(join(root, dir), { recursive: true })
  const view = join(root, 'world'); const taskRoot = join(root, 'tasks')
  const world = { worldId: 'world', readRoot: view, confirmedRoot: join(view, 'confirmed'), catalogRoot: join(view, 'catalog'), mainAgent: { agentId: 'main', writableRoot: join(view, 'main') }, agents: [] }
  const context = new Context(); const backend = await context.plugin(LocalFileSystem, { cwd: root }); t.after(() => backend.dispose())
  if (!(context.fs instanceof LocalFileSystem)) throw new Error('测试需要本机后端')
  let current = { content: '城门开放', version: 'v1' }
  const adapter: DiscussionTargetAdapter = { worldBinding: world, isTargetBoundToWorld: () => true, async read() { return current },
    async assertNoLegacyCandidate() {}, async validateStored() {}, async validate() {} }
  const gate = WorldAccess.register([view, taskRoot]); t.after(() => gate.close())
  const options = { worlds: [world], worldId: world.worldId, root: taskRoot, otherRoots: [join(root, 'session')], fs: context.fs, gate, adapter, singleWriterProcess: true as const }
  let store = await InitializationTaskStore.open(options)
  const taskId = randomUUID(); const judgmentId = randomUUID(); const createdAt = new Date().toISOString()
  await assert.rejects(store.readTask(taskId), /不存在/)
  const task = { id: taskId, sessionIds: ['session-1'], createdAt }
  const write = context.fs.writeText.bind(context.fs)
  context.fs.writeText = async () => { throw new Error('注入写入前失败') }
  await assert.rejects(store.createTask(task), /结果不确定/)
  await assert.rejects(store.readTask(taskId), /不存在/)
  context.fs.writeText = async (...args) => { await write(...args); throw new Error('注入写入后响应丢失') }
  await assert.rejects(store.createTask(task), /结果不确定/)
  context.fs.writeText = write
  const first = await store.createTask(task); assert.equal((await store.createTask(task)).version, first.version)
  await assert.rejects(store.createTask({ ...task, sessionIds: ['another'] }), /不同记录/)
  const target = { kind: 'place' as const, id: randomUUID() }
  const judgment = { id: judgmentId, taskId, createdAt, actor: 'user' as const, scope: '地点资料', artifacts: [{ target, version: 'v1' }] }
  await assert.rejects(store.confirmFirstVersion({ ...judgment, artifacts: [{ target, version: 'stale' }] }), /已变化/)
  await store.confirmFirstVersion(judgment)
  await store.close(); store = await InitializationTaskStore.open(options)
  assert.equal((await store.readFirstVersion(taskId, judgmentId)).artifacts[0]?.status, 'current')
  current = { content: '城门关闭', version: 'v2' }
  assert.equal((await store.readFirstVersion(taskId, judgmentId)).artifacts[0]?.status, 'changed')
  await store.confirmFirstVersion(judgment)
  const discovered = await discoverInitialization({ worlds: [world], worldId: world.worldId, roots: { task: taskRoot }, sessionRoots: [join(root, 'session')] })
  assert.equal(discovered.entries.filter(item => item.status === 'valid').length, 2)
  assert.deepEqual(discovered.issues, [])
  const unknownId = randomUUID(); await writeFile(join(taskRoot, 'tasks', `${unknownId}.json`), '{"formatVersion":99}')
  await assert.rejects(store.readTask(unknownId))
  await store.close()
})
