import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { fsSandboxPluginDefinition, SandboxedFileSystem } from '@fly-novel/fs-sandbox'
import { LocalFileSystem } from '@fly-novel/fs-local'
import { sandboxPolicyPluginDefinition } from '@fly-novel/sandbox-policy'
import { fsObservationPolicyPluginDefinition } from '@fly-novel/fs-observation-policy'
import { bootstrapAgents } from '../core/bootstrap.js'
import { createTestAgent, withAgentLoop } from './agent-loop-fixtures.js'

test('只读拒绝修改，可信可写策略允许工作区并拒绝非授权兄弟目录', async t => {
  const parent = join(process.cwd(), 'tmp')
  await mkdir(parent, { recursive: true })
  const dir = await mkdtemp(join(parent, 'fly-fs-sandbox-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const root = join(dir, 'workspace')
  const outside = join(dir, 'outside')
  await mkdir(root); await mkdir(outside)
  const realRoot = await realpath(root)
  const framework = await bootstrapAgents()
  t.after(() => framework.manager.disposeAll())
  framework.plugins.register(sandboxPolicyPluginDefinition)
  framework.plugins.register(fsSandboxPluginDefinition)
  framework.presets.register({ id: 'sandbox-backend', version: '1', role: 'character', plugins: withAgentLoop([{ pluginId: 'sandbox-policy' }, { pluginId: 'fs-sandbox' }]) })
  const make = (id: string, config: object) => createTestAgent(framework, { id, presetId: 'sandbox-backend', pluginConfigs: { 'sandbox-policy': config, 'fs-sandbox': { cwd: root } } })
  const a = await make('restricted', { mode: 'workspace-write', workspaceRoot: realRoot })
  const b = await make('readonly', {})
  const fs = a.context.fs
  assert.ok(fs instanceof SandboxedFileSystem)
  const duplicate = a.context.plugin(LocalFileSystem, { cwd: root })
  await assert.rejects(duplicate.await())
  await duplicate.dispose()
  const inside = await fs.resolve('inside')
  const escape = await fs.resolve(join(outside, 'file'))
  await fs.writeText(inside, 'good')
  await assert.rejects(fs.writeText(escape, 'bad'), { code: 'FS_SANDBOX_DENIED' })
  await assert.rejects(b.context.fs.writeText(await b.context.fs.resolve('blocked'), 'bad'), { code: 'FS_SANDBOX_DENIED' })
  assert.equal(await readFile(join(root, 'inside'), 'utf8'), 'good')
  assert.equal(await fs.stat(escape), undefined)
  await framework.manager.dispose('restricted')
  assert.equal(a.context.get('fs'), undefined)
  assert.ok(b.context.get('fs'))
})

test('缺少策略时拒绝装配文件后端', async t => {
  const framework = await bootstrapAgents()
  t.after(() => framework.manager.disposeAll())
  framework.plugins.register(fsSandboxPluginDefinition)
  framework.presets.register({ id: 'sandbox-no-policy', version: '1', role: 'character', plugins: withAgentLoop([{ pluginId: 'fs-sandbox' }]) })
  await assert.rejects(createTestAgent(framework, { id: 'missing-policy', presetId: 'sandbox-no-policy' }), /依赖未就绪/)
})

test('观察版本保护与修改授权组合时，拒绝越界且保留文件内容', async t => {
  const parent = join(process.cwd(), 'tmp')
  await mkdir(parent, { recursive: true })
  const dir = await mkdtemp(join(parent, 'fly-sandbox-observation-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const work = join(dir, 'work'); const outside = join(dir, 'outside')
  await mkdir(work); await mkdir(outside)
  await writeFile(join(work, 'file'), 'inside')
  await writeFile(join(outside, 'file'), 'outside')
  const framework = await bootstrapAgents()
  t.after(() => framework.manager.disposeAll())
  framework.plugins.register(sandboxPolicyPluginDefinition)
  framework.plugins.register(fsSandboxPluginDefinition)
  framework.plugins.register(fsObservationPolicyPluginDefinition)
  framework.presets.register({ id: 'sandbox-observed', version: '1', role: 'character', plugins: withAgentLoop([{ pluginId: 'tools' }, { pluginId: 'sandbox-policy' }, { pluginId: 'fs-sandbox' }, { pluginId: 'fs-observation-policy' }]) })
  const agent = await createTestAgent(framework, { id: 'observed', presetId: 'sandbox-observed', pluginConfigs: { 'sandbox-policy': { mode: 'workspace-write', workspaceRoot: await realpath(work) }, 'fs-sandbox': { cwd: work } } })
  const fs = agent.context.fs
  const actor = { agent: agent.context.tools.agent, session: agent.context.sessions.list()[0]! }
  const inside = await fs.resolve('file'); const external = await fs.resolve(join(outside, 'file'))
  for (const target of [inside, external]) {
    const info = await fs.stat(target)
    assert.ok(info)
    agent.context.emit('fs/observed', target, { kind: 'present', version: info.version }, actor)
  }
  const edit = { oldString: 'inside', newString: 'changed', replaceAll: false }
  const guard = await agent.context.waterfall('fs/edit-intent', inside, actor, () => undefined)
  await fs.editText(inside, edit, guard)
  const externalGuard = await agent.context.waterfall('fs/edit-intent', external, actor, () => undefined)
  await assert.rejects(fs.editText(external, { ...edit, oldString: 'outside' }, externalGuard), { code: 'FS_SANDBOX_DENIED' })
  assert.equal(await readFile(join(outside, 'file'), 'utf8'), 'outside')
  assert.equal(await readFile(join(work, 'file'), 'utf8'), 'changed')
})
