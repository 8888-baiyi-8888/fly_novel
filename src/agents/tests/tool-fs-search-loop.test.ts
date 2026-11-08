import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, type GenerateOptions, type StreamChunk, type ToolCallId } from '@fly-novel/llm'
import { LocalFileSystem } from '@fly-novel/fs-local'
import { toolFsReadPluginDefinition } from '@fly-novel/tool-fs'
import { localSubprocessPluginDefinition } from '@fly-novel/subprocess-local'
import { toolFsSearchPluginDefinition } from '@fly-novel/tool-fs-search'
import { bootstrapAgents } from '../core/bootstrap.js'
import { createTestAgent, withAgentLoop } from './agent-loop-fixtures.js'

class SearchAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const calls = [
      { name: 'glob', args: { pattern: '*.txt' } },
      { name: 'grep', args: { pattern: 'marker' } },
      { name: 'read', args: { file_path: 'visible.txt' } },
    ]
    const next = calls[this.requests.length - 1]
    if (next) {
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `id-${this.requests.length}` as ToolCallId, name: next.name, arguments: JSON.stringify(next.args) } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '完成' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

test('真实 Loop 搜索后读取，两个 Agent 仅访问各自视图', async t => {
  const parent = join(process.cwd(), 'tmp'); await mkdir(parent, { recursive: true })
  const dir = await mkdtemp(join(parent, 'fly-search-loop-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const aRoot = join(dir, 'a'); const bRoot = join(dir, 'b')
  await mkdir(aRoot); await mkdir(bRoot)
  await writeFile(join(aRoot, 'visible.txt'), 'marker from a\n')
  await writeFile(join(bRoot, 'private.txt'), 'marker from b\n')
  const framework = await bootstrapAgents()
  t.after(() => framework.manager.disposeAll())
  const provider = Object.assign(async (ctx: Context, config: { cwd: string }) => { await ctx.plugin(LocalFileSystem, config) }, { provide: 'fs' as const })
  framework.plugins.register({ id: 'search-loop-fs', version: '1', plugin: provider })
  for (const plugin of [toolFsReadPluginDefinition, localSubprocessPluginDefinition, toolFsSearchPluginDefinition]) framework.plugins.register(plugin)
  framework.presets.register({ id: 'search-loop', version: '1', role: 'character', plugins: withAgentLoop([{ pluginId: 'tools' }, { pluginId: 'search-loop-fs' }, { pluginId: 'subprocess-local' }, { pluginId: 'tool-fs-read' }, { pluginId: 'tool-fs-search' }]) })
  const make = (id: string, root: string) => createTestAgent(framework, { id, presetId: 'search-loop', pluginConfigs: {
    'search-loop-fs': { cwd: root }, 'agent-loop-runtime': { provider: 'test-provider', model: 'test-model', workingDirectory: root },
    llm: { adapters: [{ providers: ['test-provider'], adapter: new SearchAdapter() }] },
  } })
  const a = await make('search-a', aRoot); const b = await make('search-b', bRoot)
  assert.deepEqual(await a.run({ prompt: '搜索并读取' }), { content: '完成' })
  const results = a.context.sessions.list()[0]!.read().filter(event => event.type === 'tool/result')
  assert.equal(results.length, 3)
  assert.ok(results.every(event => event.data.error === undefined))
  assert.match(JSON.stringify(results), /visible\.txt/)
  assert.match(JSON.stringify(results), /marker from a/)
  assert.doesNotMatch(JSON.stringify(results), /marker from b|private\.txt/)
  const denied = await b.context.tools.execute({ calls: [{ type: 'tool-call', id: 'outside' as ToolCallId, name: 'grep', arguments: JSON.stringify({ pattern: 'marker', path: aRoot }) }], workingDirectory: bRoot, session: b.context.sessions.list()[0]!, signal: new AbortController().signal })
  assert.equal(denied.results[0]!.result.isError, true)
  await framework.manager.dispose('search-a')
  assert.ok(b.context.tools.get('grep'))
})
