import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import type { ToolCallId } from '@fly-novel/llm'
import type { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@fly-novel/fs-local'
import { fsSandboxPluginDefinition } from '@fly-novel/fs-sandbox'
import { sandboxPolicyPluginDefinition } from '@fly-novel/sandbox-policy'
import { fsObservationPolicyPluginDefinition } from '@fly-novel/fs-observation-policy'
import { toolFsMutationPluginDefinition, toolFsReadPluginDefinition } from '@fly-novel/tool-fs'
import { bootstrapAgents } from '../core/bootstrap.js'
import { createTestAgent, withAgentLoop } from './agent-loop-fixtures.js'

test('真实工具链按观察与沙箱执行写入、编辑并拒绝越界', async t => {
  const parent = join(process.cwd(), 'tmp'); await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'fly-tool-mutation-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const work = join(root, 'work'); const outside = join(root, 'outside')
  await mkdir(work); await mkdir(outside)
  await writeFile(join(work, 'file'), 'before')
  await writeFile(join(outside, 'secret'), 'secret')
  const framework = await bootstrapAgents()
  t.after(() => framework.manager.disposeAll())
  for (const plugin of [fsSandboxPluginDefinition, sandboxPolicyPluginDefinition, fsObservationPolicyPluginDefinition, toolFsReadPluginDefinition, toolFsMutationPluginDefinition]) framework.plugins.register(plugin)
  framework.presets.register({ id: 'tool-fs-full', version: '1', role: 'character', plugins: withAgentLoop([{ pluginId: 'tools' }, { pluginId: 'sandbox-policy' }, { pluginId: 'fs-sandbox' }, { pluginId: 'fs-observation-policy' }, { pluginId: 'tool-fs-read' }, { pluginId: 'tool-fs-mutation' }]) })
  const agent = await createTestAgent(framework, { id: 'writer', presetId: 'tool-fs-full', pluginConfigs: { 'sandbox-policy': { mode: 'workspace-write', workspaceRoot: await realpath(work) }, 'fs-sandbox': { cwd: work } } })
  const session = agent.context.sessions.list()[0]!
  const call = async (name: string, args: object) => (await agent.context.tools.execute({ calls: [{ type: 'tool-call', id: 'id' as ToolCallId, name, arguments: JSON.stringify(args) }], workingDirectory: work, session, signal: new AbortController().signal })).results[0]!.result
  const unseen = await call('write', { file_path: 'file', content: 'wrong' })
  assert.equal(unseen.isError, true)
  if (unseen.isError) assert.equal(unseen.error.info.code, 'FS_NOT_OBSERVED')
  assert.equal((await call('read', { file_path: 'file' })).isError, false)
  assert.equal((await call('edit', { file_path: 'file', old_string: 'before', new_string: 'edited' })).isError, false)
  const written = await call('write', { file_path: 'file', content: 'written' })
  assert.equal(written.isError, false)
  assert.doesNotMatch(JSON.stringify(written), /edited/)
  const denied = await call('write', { file_path: join(outside, 'secret'), content: 'bad' })
  assert.equal(denied.isError, true)
  if (denied.isError) assert.equal(denied.error.info.code, 'FS_SANDBOX_DENIED')
  const deniedEdit = await call('edit', { file_path: join(outside, 'secret'), old_string: 'secret', new_string: 'bad' })
  assert.equal(deniedEdit.isError, true)
  if (deniedEdit.isError) assert.equal(deniedEdit.error.info.code, 'FS_PERMISSION_DENIED')
  assert.equal(await readFile(join(work, 'file'), 'utf8'), 'written')
  assert.equal(await readFile(join(outside, 'secret'), 'utf8'), 'secret')
})

test('普通无沙箱后端不能装配修改工具', async t => {
  const framework = await bootstrapAgents()
  t.after(() => framework.manager.disposeAll())
  const provider = Object.assign(async (ctx: Context) => { await ctx.plugin(LocalFileSystem, { cwd: process.cwd() }) }, { provide: 'fs' as const })
  framework.plugins.register({ id: 'unsafe-fs', version: '1', plugin: provider })
  framework.plugins.register(toolFsMutationPluginDefinition)
  framework.presets.register({ id: 'unsafe-tool', version: '1', role: 'character', plugins: withAgentLoop([{ pluginId: 'tools' }, { pluginId: 'unsafe-fs' }, { pluginId: 'tool-fs-mutation' }]) })
  await assert.rejects(createTestAgent(framework, { id: 'unsafe', presetId: 'unsafe-tool' }), /必须装配沙箱/)
  assert.throws(() => framework.manager.get('unsafe'), /不存在/)
})
