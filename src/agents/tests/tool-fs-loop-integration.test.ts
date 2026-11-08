import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@fly-novel/fs-local'
import { LlmAdapter, type GenerateOptions, type StreamChunk, type ToolCallId } from '@fly-novel/llm'
import { fsSandboxPluginDefinition } from '@fly-novel/fs-sandbox'
import { sandboxPolicyPluginDefinition } from '@fly-novel/sandbox-policy'
import { fsObservationPolicyPluginDefinition } from '@fly-novel/fs-observation-policy'
import { toolFsPluginDefinition } from '@fly-novel/tool-fs'
import { bootstrapAgents } from '../core/bootstrap.js'
import { createTestAgent, withAgentLoop } from './agent-loop-fixtures.js'

class FixedToolAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const calls = [
      { name: 'read', args: { file_path: 'file' } },
      { name: 'edit', args: { file_path: 'file', old_string: 'old', new_string: 'new' } },
      { name: 'write', args: { file_path: 'created', content: 'created' } },
      { name: 'apply_patch', args: { input: '*** Begin Patch\n*** Delete File: file\n*** End Patch' } },
    ]
    const next = calls[this.requests.length - 1]
    if (next) {
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `call-${this.requests.length}` as ToolCallId, name: next.name, arguments: JSON.stringify(next.args) } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '完成' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

test('真实 Loop 调用文件工具并隔离两个 Agent 的读取和修改范围', async t => {
  const parent = join(process.cwd(), 'tmp'); await mkdir(parent, { recursive: true })
  const dir = await mkdtemp(join(parent, 'fly-tool-fs-loop-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const aRoot = join(dir, 'a'); const bRoot = join(dir, 'b')
  await mkdir(aRoot); await mkdir(bRoot)
  await writeFile(join(aRoot, 'file'), 'old\n')
  await writeFile(join(bRoot, 'file'), 'private')
  const framework = await bootstrapAgents()
  t.after(() => framework.manager.disposeAll())
  for (const plugin of [fsSandboxPluginDefinition, sandboxPolicyPluginDefinition, fsObservationPolicyPluginDefinition, toolFsPluginDefinition]) framework.plugins.register(plugin)
  framework.presets.register({ id: 'tool-fs-loop', version: '1', role: 'character', plugins: withAgentLoop([{ pluginId: 'tools' }, { pluginId: 'sandbox-policy' }, { pluginId: 'fs-sandbox' }, { pluginId: 'fs-observation-policy' }, { pluginId: 'tool-fs' }]) })
  const aAdapter = new FixedToolAdapter(); const bAdapter = new FixedToolAdapter()
  const make = async (id: string, root: string, adapter: FixedToolAdapter, applyPatch: boolean) => createTestAgent(framework, { id, presetId: 'tool-fs-loop', pluginConfigs: {
    'agent-loop-runtime': { provider: 'test-provider', model: 'test-model', workingDirectory: root },
    llm: { adapters: [{ providers: ['test-provider'], adapter }] },
    'sandbox-policy': { mode: 'workspace-write', workspaceRoot: await realpath(root) }, 'fs-sandbox': { cwd: root }, 'tool-fs': { applyPatch },
  } })
  const a = await make('a', aRoot, aAdapter, true)
  const b = await make('b', bRoot, bAdapter, false)
  assert.deepEqual(a.context.tools.schemas().map(x => x.name), ['read', 'write', 'edit', 'apply_patch'])
  assert.deepEqual(b.context.tools.schemas().map(x => x.name), ['read', 'write', 'edit'])
  assert.deepEqual(await a.run({ prompt: '修改文件' }), { content: '完成' })
  assert.equal(await readFile(join(aRoot, 'created'), 'utf8'), 'created')
  await assert.rejects(readFile(join(aRoot, 'file')))
  const results = a.context.sessions.list()[0]!.read().filter(event => event.type === 'tool/result')
  assert.equal(results.length, 4)
  assert.ok(results.every(event => event.data.error === undefined))
  const bSession = b.context.sessions.list()[0]!
  const denied = await b.context.tools.execute({ calls: [{ type: 'tool-call', id: 'outside' as ToolCallId, name: 'read', arguments: JSON.stringify({ file_path: join(aRoot, 'created') }) }], workingDirectory: bRoot, session: bSession, signal: new AbortController().signal })
  assert.equal(denied.results[0]?.result.isError, true)
  assert.equal(await readFile(join(bRoot, 'file'), 'utf8'), 'private')
  await framework.manager.dispose('a')
  assert.equal(a.context.get('tools'), undefined)
  assert.ok(b.context.tools.get('read'))
})

test('组合插件初始化失败时清理已注册工具', async t => {
  const framework = await bootstrapAgents()
  t.after(() => framework.manager.disposeAll())
  let context: Context | undefined
  const provider = Object.assign(async (ctx: Context) => {
    context = ctx
    await ctx.plugin(LocalFileSystem, { cwd: process.cwd() })
  }, { provide: 'fs' as const })
  framework.plugins.register({ id: 'unsafe-fs', version: '1', plugin: provider })
  framework.plugins.register(toolFsPluginDefinition)
  framework.presets.register({ id: 'unsafe-combined-tool', version: '1', role: 'character', plugins: withAgentLoop([{ pluginId: 'tools' }, { pluginId: 'unsafe-fs' }, { pluginId: 'tool-fs' }]) })
  await assert.rejects(createTestAgent(framework, { id: 'unsafe', presetId: 'unsafe-combined-tool' }), /必须装配沙箱/)
  assert.throws(() => framework.manager.get('unsafe'), /不存在/)
  assert.equal(context?.get('tools'), undefined)
})
