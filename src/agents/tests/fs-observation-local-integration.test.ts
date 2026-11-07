import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@fly-novel/fs-local'
import { fsObservationPolicyPluginDefinition } from '@fly-novel/fs-observation-policy'
import type { FsTarget } from '../plugins/fs/fs/index.js'
import { parsePatch } from '../plugins/fs/fs-patch/index.js'
import { bootstrapAgents } from '../core/bootstrap.js'
import type { Agent } from '../core/contracts/agent.js'
import { createTestAgent, withAgentLoop } from './agent-loop-fixtures.js'

// 可信测试适配器：只在观察或修改完成后发布事件，不是生产文件工具。
function adapter(agent: Agent, fs: LocalFileSystem) {
  const ctx = agent.context
  const actor = { agent: ctx.tools.agent, session: ctx.sessions.list()[0]! }
  const fallback = () => undefined
  const writeIntent = (target: FsTarget) => ctx.waterfall('fs/write-intent', target, actor, fallback)
  const editIntent = (target: FsTarget) => ctx.waterfall('fs/edit-intent', target, actor, fallback)
  const deleteIntent = (target: FsTarget) => ctx.waterfall('fs/delete-intent', target, actor, fallback)
  return {
    actor, writeIntent, editIntent, deleteIntent,
    async observe(target: FsTarget) {
      const info = await fs.stat(target)
      if (!info) { ctx.emit('fs/observed', target, { kind: 'absent' }, actor); return undefined }
      const content = await fs.readText(target)
      ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, actor)
      return content
    },
    async write(target: FsTarget, content: string, signal?: AbortSignal) {
      const outcome = await fs.writeText(target, content, await writeIntent(target), signal)
      ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, actor)
      return outcome
    },
    async edit(target: FsTarget, oldString: string, newString: string) {
      const outcome = await fs.editText(target, { oldString, newString, replaceAll: false }, await editIntent(target))
      ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, actor)
      return outcome
    },
    async patch(target: FsTarget) {
      const [operation] = parsePatch('*** Begin Patch\n*** Update File: f\n@@\n-two\n+three\n*** End Patch')
      if (operation?.kind !== 'update') throw new Error('补丁无效')
      const outcome = await fs.patchText(target, operation.hunks, await editIntent(target))
      ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, actor)
      return outcome
    },
    async remove(target: FsTarget) {
      const result = await fs.deleteFile(target, await deleteIntent(target))
      ctx.emit('fs/observed', target, { kind: 'absent' }, actor)
      return result
    },
    async move(source: FsTarget, destination: FsTarget) {
      const expectedSource = await editIntent(source)
      const expectedDestination = await writeIntent(destination)
      const result = await fs.moveFile(source, destination, { expectedSource, expectedDestination })
      ctx.emit('fs/observed', destination, { kind: 'present', version: result.destination.version }, actor)
      if (result.sourceDeleted) ctx.emit('fs/observed', source, { kind: 'absent' }, actor)
      return result
    },
  }
}

async function setup(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'fly-observation-integration-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const fsContext = new Context()
  const scope = await fsContext.plugin(LocalFileSystem, { cwd: dir })
  t.after(() => scope.dispose())
  const fs = fsContext.fs as LocalFileSystem
  const framework = await bootstrapAgents()
  t.after(() => framework.manager.disposeAll())
  framework.plugins.register(fsObservationPolicyPluginDefinition)
  framework.presets.register({ id: 'local-policy-on', version: '1', role: 'character', plugins: withAgentLoop([{ pluginId: 'tools' }, { pluginId: 'fs-observation-policy' }]) })
  framework.presets.register({ id: 'local-policy-off', version: '1', role: 'character', plugins: withAgentLoop([{ pluginId: 'tools' }]) })
  const create = (id: string, policy = true) => createTestAgent(framework, { id, presetId: policy ? 'local-policy-on' : 'local-policy-off' })
  return { dir, fs, framework, create }
}

test('真实后端：读取、创建、编辑、补丁和删除按观察保护', async t => {
  const { dir, fs, create } = await setup(t)
  const agent = await create('local-a')
  const io = adapter(agent, fs)
  await writeFile(join(dir, 'existing'), 'one\n')
  const existing = await fs.resolve('existing')
  await assert.rejects(io.write(existing, 'unseen'), { code: 'FS_NOT_OBSERVED' })
  assert.equal(await io.observe(existing), 'one\n')
  await io.write(existing, 'two\n')
  await io.patch(existing)
  await io.edit(existing, 'three', 'four')
  assert.equal(await readFile(join(dir, 'existing'), 'utf8'), 'four\n')
  await io.remove(existing)
  await assert.rejects(io.edit(existing, 'four', 'x'), { code: 'FS_NOT_FOUND' })
  const fresh = await fs.resolve('fresh')
  assert.equal(await io.observe(fresh), undefined)
  await io.write(fresh, 'created')
  assert.equal(await readFile(join(dir, 'fresh'), 'utf8'), 'created')
  await fs.writeText(fresh, 'direct overwrite')
  assert.equal(await readFile(join(dir, 'fresh'), 'utf8'), 'direct overwrite')
})

test('观察后外部修改、删除及暂存期间竞争创建不会被错误覆盖', async t => {
  const { dir, fs, create } = await setup(t)
  const io = adapter(await create('race'), fs)
  const target = await fs.resolve('file')
  await writeFile(join(dir, 'file'), 'old')
  await io.observe(target)
  const prior = await io.editIntent(target)
  await writeFile(join(dir, 'file'), 'external-change-longer')
  await assert.rejects(io.edit(target, 'old', 'ours'), { code: 'FS_STALE_VERSION' })
  assert.deepEqual(await io.editIntent(target), prior)
  assert.equal(await readFile(join(dir, 'file'), 'utf8'), 'external-change-longer')
  await rm(join(dir, 'file'))
  await assert.rejects(io.write(target, 'ours'), { code: 'FS_STALE_VERSION' })
  assert.deepEqual(await io.editIntent(target), prior)
  const race = await fs.resolve('race')
  await io.observe(race)
  fs.internals.inspectTemp = async () => { await writeFile(join(dir, 'race'), 'competitor') }
  t.after(() => { delete fs.internals.inspectTemp })
  await assert.rejects(io.write(race, 'ours'), { code: 'FS_NOT_OBSERVED' })
  assert.equal(await readFile(join(dir, 'race'), 'utf8'), 'competitor')
  assert.deepEqual(await io.writeIntent(race), { kind: 'createIfAbsent' })
})

test('移动使用源编辑与目标写入保护，删除源失败只更新目标观察', async t => {
  const { dir, fs, create } = await setup(t)
  const io = adapter(await create('move'), fs)
  await writeFile(join(dir, 'source'), 'source')
  const source = await fs.resolve('source')
  const destination = await fs.resolve('destination')
  await assert.rejects(io.move(source, destination), { code: 'FS_NOT_OBSERVED' })
  await io.observe(source)
  await io.observe(destination)
  fs.internals.removeFile = async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) }
  t.after(() => { delete fs.internals.removeFile })
  const outcome = await io.move(source, destination)
  assert.equal(outcome.sourceDeleted, false)
  assert.equal(await readFile(join(dir, 'source'), 'utf8'), 'source')
  assert.equal(await readFile(join(dir, 'destination'), 'utf8'), 'source')
  assert.deepEqual(await io.editIntent(source), { version: (await fs.stat(source))?.version })
  assert.deepEqual(await io.editIntent(destination), { version: outcome.destination.version })
  delete fs.internals.removeFile
  const secondDestination = await fs.resolve('destination2')
  await io.observe(secondDestination)
  assert.equal((await io.move(source, secondDestination)).sourceDeleted, true)
  await assert.rejects(io.editIntent(source), { code: 'FS_NOT_FOUND' })
})

test('取消、后端失败和观察监听器失败不伪造观察结果', async t => {
  const { dir, fs, framework, create } = await setup(t)
  const agent = await create('errors')
  const io = adapter(agent, fs)
  const target = await fs.resolve('file')
  await writeFile(join(dir, 'file'), 'before')
  await io.observe(target)
  const previous = await io.editIntent(target)
  const abort = new AbortController()
  fs.internals.inspectTemp = () => abort.abort()
  await assert.rejects(io.write(target, 'cancelled', abort.signal), { code: 'FS_ABORTED' })
  assert.deepEqual(await io.editIntent(target), previous)
  fs.internals.inspectTemp = () => { throw Object.assign(new Error('I/O failure'), { code: 'EIO' }) }
  await assert.rejects(io.write(target, 'failed'), { code: 'FS_IO_ERROR' })
  assert.deepEqual(await io.editIntent(target), previous)
  delete fs.internals.inspectTemp
  const listener = framework.context.plugin(ctx => { ctx.on('fs/observed', () => { throw new Error('listener failure') }) })
  await listener
  t.after(() => listener.dispose())
  await assert.rejects(io.write(target, 'committed'), /listener failure/)
  assert.equal(await readFile(join(dir, 'file'), 'utf8'), 'committed')
  assert.deepEqual(await io.editIntent(target), { version: (await fs.stat(target))?.version })
})

test('两个 Agent 对同一真实文件隔离观察，顺序反转和销毁不改变另一方', async t => {
  const { dir, fs, framework, create } = await setup(t)
  for (const order of [['alpha', 'beta'], ['beta2', 'alpha2']]) {
    const first = await create(order[0]!)
    const second = await create(order[1]!)
    const a = adapter(first, fs)
    const b = adapter(second, fs)
    const path = `shared-${order[0]}`
    await writeFile(join(dir, path), 'original')
    const target = await fs.resolve(path)
    await a.observe(target)
    await assert.rejects(b.edit(target, 'original', 'unobserved'), { code: 'FS_NOT_OBSERVED' })
    await b.observe(target)
    await a.write(target, 'first changed')
    await assert.rejects(b.write(target, 'stale'), { code: 'FS_STALE_VERSION' })
    await b.observe(target)
    await framework.manager.dispose(order[0]!)
    await b.write(target, 'second changed')
    assert.equal(await readFile(join(dir, path), 'utf8'), 'second changed')
    await framework.manager.dispose(order[1]!)
  }
})

test('只有一个 Agent 装配策略时，另一 Agent 的事件正常委派', async t => {
  const { dir, fs, create } = await setup(t)
  const protectedAgent = await create('protected')
  const bareAgent = await create('bare', false)
  const protectedIo = adapter(protectedAgent, fs)
  const bareIo = adapter(bareAgent, fs)
  const target = await fs.resolve('shared')
  await writeFile(join(dir, 'shared'), 'before')
  await protectedIo.observe(target)
  assert.equal(await bareIo.writeIntent(target), undefined)
  await bareIo.write(target, 'bare write')
  await assert.rejects(protectedIo.write(target, 'stale write'), { code: 'FS_STALE_VERSION' })
  assert.equal(await readFile(join(dir, 'shared'), 'utf8'), 'bare write')
})

test('意图监听器失败时不调用后端也不更新已记录的观察', async t => {
  const { dir, fs, framework, create } = await setup(t)
  const listener = framework.context.plugin(ctx => {
    ctx.on('fs/write-intent', async () => { throw new Error('intent failure') })
  })
  await listener
  t.after(() => listener.dispose())
  const agent = await create('intent-error')
  const io = adapter(agent, fs)
  const target = await fs.resolve('file')
  await writeFile(join(dir, 'file'), 'before')
  await io.observe(target)
  const previous = await io.editIntent(target)
  await assert.rejects(io.write(target, 'after'), /intent failure/)
  assert.equal(await readFile(join(dir, 'file'), 'utf8'), 'before')
  assert.deepEqual(await io.editIntent(target), previous)
})
