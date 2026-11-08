import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import type { ToolCallId } from '@fly-novel/llm'
import { SandboxedFileSystem, fsSandboxPluginDefinition } from '@fly-novel/fs-sandbox'
import { sandboxPolicyPluginDefinition } from '@fly-novel/sandbox-policy'
import { fsObservationPolicyPluginDefinition } from '@fly-novel/fs-observation-policy'
import { toolFsPatchPluginDefinition, toolFsReadPluginDefinition } from '@fly-novel/tool-fs'
import { bootstrapAgents } from '../core/bootstrap.js'
import { createTestAgent, withAgentLoop } from './agent-loop-fixtures.js'

async function setup(t: TestContext) {
  const parent = join(process.cwd(), 'tmp'); await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'fly-tool-patch-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const framework = await bootstrapAgents()
  t.after(() => framework.manager.disposeAll())
  for (const plugin of [fsSandboxPluginDefinition, sandboxPolicyPluginDefinition, fsObservationPolicyPluginDefinition, toolFsReadPluginDefinition, toolFsPatchPluginDefinition]) framework.plugins.register(plugin)
  framework.presets.register({ id: 'patch-agent', version: '1', role: 'character', plugins: withAgentLoop([{ pluginId: 'tools' }, { pluginId: 'sandbox-policy' }, { pluginId: 'fs-sandbox' }, { pluginId: 'fs-observation-policy' }, { pluginId: 'tool-fs-read' }, { pluginId: 'tool-fs-patch' }]) })
  const agent = await createTestAgent(framework, { id: 'patcher', presetId: 'patch-agent', pluginConfigs: { 'sandbox-policy': { mode: 'workspace-write', workspaceRoot: await realpath(root) }, 'fs-sandbox': { cwd: root } } })
  const session = agent.context.sessions.list()[0]!
  const call = async (name: string, args: object, signal = new AbortController().signal) => (await agent.context.tools.execute({ calls: [{ type: 'tool-call', id: 'id' as ToolCallId, name, arguments: JSON.stringify(args) }], workingDirectory: root, session, signal })).results[0]!.result
  const patch = async (input: string, signal?: AbortSignal) => {
    const result = await call('apply_patch', { input }, signal)
    assert.equal(result.isError, false, JSON.stringify(result))
    if (result.isError || typeof result.value !== 'string') throw new Error('补丁未返回报告')
    return JSON.parse(result.value) as { phase: string; cancelled?: boolean; outcomes?: Array<{ status: string; changedPaths?: string[] }> }
  }
  return { root, framework, agent, call, patch }
}

test('多文件补丁预检后按顺序创建、更新、删除，未观察更新被拒绝', async t => {
  const { root, call, patch } = await setup(t)
  await writeFile(join(root, 'file'), 'old\n')
  const input = '*** Begin Patch\n*** Add File: added\n+new\n*** Update File: file\n@@\n-old\n+changed\n*** End Patch'
  const refused = await patch(input)
  assert.equal(refused.phase, 'preflight')
  await assert.rejects(readFile(join(root, 'added')))
  assert.equal((await call('read', { file_path: 'file' })).isError, false)
  const result = await patch(input)
  assert.deepEqual(result.outcomes?.map(x => x.status), ['completed', 'completed'])
  assert.equal(await readFile(join(root, 'file'), 'utf8'), 'changed\n')
  const removed = await patch('*** Begin Patch\n*** Delete File: file\n*** End Patch')
  assert.deepEqual(removed.outcomes?.map(x => x.status), ['completed'])
  await assert.rejects(readFile(join(root, 'file')))
})

test('第二项提交失败时报告第一项成功和后续跳过', async t => {
  const { root, agent, patch } = await setup(t)
  const fs = agent.context.fs
  assert.ok(fs instanceof SandboxedFileSystem)
  let count = 0
  fs.internals.inspectTemp = () => { if (++count === 2) throw Object.assign(new Error('fault'), { code: 'EIO' }) }
  const result = await patch('*** Begin Patch\n*** Add File: one\n+1\n*** Add File: two\n+2\n*** Add File: three\n+3\n*** End Patch')
  assert.deepEqual(result.outcomes?.map(x => x.status), ['completed', 'failed', 'skipped'])
  assert.equal(await readFile(join(root, 'one'), 'utf8'), '1\n')
  await assert.rejects(readFile(join(root, 'two')))
  await assert.rejects(readFile(join(root, 'three')))
})

test('取消在第一项完成后保留已提交及跳过报告', async t => {
  const { root, framework, patch } = await setup(t)
  const abort = new AbortController()
  const listener = framework.context.plugin(ctx => { ctx.on('fs/observed', target => { if (target.displayPath.endsWith('one')) abort.abort() }) })
  await listener
  t.after(() => listener.dispose())
  const result = await patch('*** Begin Patch\n*** Add File: one\n+1\n*** Add File: two\n+2\n*** End Patch', abort.signal)
  assert.equal(result.cancelled, true)
  assert.deepEqual(result.outcomes?.map(x => x.status), ['completed', 'skipped'])
  assert.equal(await readFile(join(root, 'one'), 'utf8'), '1\n')
  await assert.rejects(readFile(join(root, 'two')))
})

test('提交后的观察监听器报错仍报告已修改路径', async t => {
  const { root, framework, patch } = await setup(t)
  const listener = framework.context.plugin(ctx => { ctx.on('fs/observed', () => { throw new Error('listener failure') }) })
  await listener
  t.after(() => listener.dispose())
  const result = await patch('*** Begin Patch\n*** Add File: one\n+1\n*** Add File: two\n+2\n*** End Patch')
  assert.deepEqual(result.outcomes?.map(x => x.status), ['failed', 'skipped'])
  assert.deepEqual(result.outcomes?.[0]?.changedPaths, [join(root, 'one')])
  assert.equal(await readFile(join(root, 'one'), 'utf8'), '1\n')
  await assert.rejects(readFile(join(root, 'two')))
})

test('补丁拒绝读取根外目标，不执行其他操作', async t => {
  const { root, patch } = await setup(t)
  const result = await patch('*** Begin Patch\n*** Add File: safe\n+1\n*** Add File: ../outside\n+2\n*** End Patch')
  assert.equal(result.phase, 'preflight')
  await assert.rejects(readFile(join(root, 'safe')))
})

test('移动目标已提交而源删除失败时报告已修改目标', async t => {
  const { root, agent, call, patch } = await setup(t)
  await writeFile(join(root, 'source'), 'old\n')
  assert.equal((await call('read', { file_path: 'source' })).isError, false)
  const fs = agent.context.fs
  assert.ok(fs instanceof SandboxedFileSystem)
  fs.internals.removeFile = async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) }
  t.after(() => { delete fs.internals.removeFile })
  const result = await patch('*** Begin Patch\n*** Update File: source\n*** Move to: destination\n@@\n-old\n+new\n*** End Patch')
  assert.deepEqual(result.outcomes?.map(x => x.status), ['failed'])
  assert.deepEqual(result.outcomes?.[0]?.changedPaths, [join(root, 'destination')])
  assert.equal(await readFile(join(root, 'source'), 'utf8'), 'old\n')
  assert.equal(await readFile(join(root, 'destination'), 'utf8'), 'new\n')
})

test('同一目标连续新增和更新按实际提交顺序执行', async t => {
  const { root, patch } = await setup(t)
  const result = await patch('*** Begin Patch\n*** Add File: file\n+old\n*** Update File: file\n@@\n-old\n+new\n*** End Patch')
  assert.deepEqual(result.outcomes?.map(x => x.status), ['completed', 'completed'])
  assert.equal(await readFile(join(root, 'file'), 'utf8'), 'new\n')
})

test('操作启动后取消时报告结果未知，后续操作未执行', async t => {
  const { root, agent, patch } = await setup(t)
  const fs = agent.context.fs
  assert.ok(fs instanceof SandboxedFileSystem)
  const abort = new AbortController()
  fs.internals.inspectTemp = () => abort.abort()
  const result = await patch('*** Begin Patch\n*** Add File: one\n+1\n*** Add File: two\n+2\n*** End Patch', abort.signal)
  assert.equal(result.cancelled, true)
  assert.deepEqual(result.outcomes?.map(x => x.status), ['unknown', 'skipped'])
  await assert.rejects(readFile(join(root, 'two')))
})

test('补丁语法无效时拒绝执行', async t => {
  const { root, patch } = await setup(t)
  const result = await patch('not a patch')
  assert.equal(result.phase, 'syntax')
  await assert.rejects(readFile(join(root, 'file')))
})
