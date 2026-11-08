import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolCallId } from '@fly-novel/llm'
import { LocalFileSystem } from '@fly-novel/fs-local'
import { fsObservationPolicyPluginDefinition } from '@fly-novel/fs-observation-policy'
import { toolFsReadPluginDefinition } from '@fly-novel/tool-fs'
import { bootstrapAgents } from '../core/bootstrap.js'
import { createTestAgent, withAgentLoop } from './agent-loop-fixtures.js'

test('真实工具服务读取成功才记录版本，读取期间变化拒绝且不记录', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fly-tool-fs-read-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'file'), 'one\ntwo\n')
  await writeFile(join(root, 'racing'), 'old')
  const framework = await bootstrapAgents()
  t.after(() => framework.manager.disposeAll())
  const provider = Object.assign(async (ctx: Context) => { await ctx.plugin(LocalFileSystem, { cwd: root }) }, { provide: 'fs' as const })
  framework.plugins.register({ id: 'read-fs', version: '1', plugin: provider })
  framework.plugins.register(fsObservationPolicyPluginDefinition)
  framework.plugins.register(toolFsReadPluginDefinition)
  framework.presets.register({ id: 'read-agent', version: '1', role: 'character', plugins: withAgentLoop([{ pluginId: 'tools' }, { pluginId: 'read-fs' }, { pluginId: 'fs-observation-policy' }, { pluginId: 'tool-fs-read' }]) })
  const agent = await createTestAgent(framework, { id: 'reader', presetId: 'read-agent' })
  const session = agent.context.sessions.list()[0]!
  const actor = { agent: agent.context.tools.agent, session }
  const read = async (name: string) => (await agent.context.tools.execute({ calls: [{ type: 'tool-call', id: 'read-id' as ToolCallId, name: 'read', arguments: JSON.stringify({ file_path: name }) }], workingDirectory: root, session, signal: new AbortController().signal })).results[0]!.result
  const ok = await read('file')
  assert.equal(ok.isError, false)
  if (!ok.isError) assert.match(JSON.stringify(ok.content), /1: one/)
  const target = await agent.context.fs.resolve('file')
  assert.deepEqual(await agent.context.waterfall('fs/edit-intent', target, actor, () => undefined), { version: (await agent.context.fs.stat(target))!.version })
  const missing = await read('missing')
  assert.equal(missing.isError, true)
  if (missing.isError) assert.equal(missing.error.info.code, 'FS_NOT_FOUND')
  const denied = await read('../outside')
  assert.equal(denied.isError, true)
  if (denied.isError) assert.equal(denied.error.info.code, 'FS_PERMISSION_DENIED')
  const absent = await agent.context.fs.resolve('missing')
  await assert.rejects(agent.context.waterfall('fs/edit-intent', absent, actor, () => undefined), { code: 'FS_NOT_FOUND' })
  const fs = agent.context.fs as LocalFileSystem
  const original = fs.streamText.bind(fs)
  t.mock.method(fs, 'streamText', async (...[target, signal]: Parameters<LocalFileSystem['streamText']>) => {
    const iterable = await original(target, signal)
    return (async function* () { for await (const chunk of iterable) { yield chunk; await writeFile(join(root, 'racing'), 'new-longer') } })()
  })
  const changed = await read('racing')
  assert.equal(changed.isError, true)
  if (changed.isError) assert.equal(changed.error.info.code, 'FS_STALE_VERSION')
  await assert.rejects(agent.context.waterfall('fs/edit-intent', await fs.resolve('racing'), actor, () => undefined), { code: 'FS_NOT_OBSERVED' })
  await framework.manager.dispose('reader')
  assert.equal(agent.context.get('tools'), undefined)
})
