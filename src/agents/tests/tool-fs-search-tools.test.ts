import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolCallId } from '@fly-novel/llm'
import { LocalFileSystem } from '@fly-novel/fs-local'
import { localSubprocessPluginDefinition } from '@fly-novel/subprocess-local'
import { toolFsSearchPluginDefinition } from '@fly-novel/tool-fs-search'
import { bootstrapAgents } from '../core/bootstrap.js'
import { createTestAgent, withAgentLoop } from './agent-loop-fixtures.js'

test('真实工具服务搜索文件并拒绝越界目录与链接', async t => {
  const parent = join(process.cwd(), 'tmp'); await mkdir(parent, { recursive: true })
  const dir = await mkdtemp(join(parent, 'fly-search-tools-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const root = join(dir, 'root'); const outside = join(dir, 'outside')
  await mkdir(root); await mkdir(outside)
  await writeFile(join(root, 'a.txt'), 'hello one\nhello two\n')
  await writeFile(join(root, 'b.txt'), 'hello three\n')
  await writeFile(join(outside, 'secret.txt'), 'secret hello\n')
  await symlink(outside, join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
  const framework = await bootstrapAgents()
  t.after(() => framework.manager.disposeAll())
  const provider = Object.assign(async (ctx: Context) => { await ctx.plugin(LocalFileSystem, { cwd: root }) }, { provide: 'fs' as const })
  framework.plugins.register({ id: 'search-fs', version: '1', plugin: provider })
  framework.plugins.register(localSubprocessPluginDefinition)
  framework.plugins.register(toolFsSearchPluginDefinition)
  framework.presets.register({ id: 'search-agent', version: '1', role: 'character', plugins: withAgentLoop([{ pluginId: 'tools' }, { pluginId: 'search-fs' }, { pluginId: 'subprocess-local' }, { pluginId: 'tool-fs-search' }]) })
  const agent = await createTestAgent(framework, { id: 'searcher', presetId: 'search-agent', pluginConfigs: { 'tool-fs-search': { globMaxResults: 1, grepMaxMatches: 1, grepMaxLineBytes: 8 } } })
  const session = agent.context.sessions.list()[0]!
  const call = async (name: string, args: object) => (await agent.context.tools.execute({ calls: [{ type: 'tool-call', id: 'id' as ToolCallId, name, arguments: JSON.stringify(args) }], workingDirectory: root, session, signal: new AbortController().signal })).results[0]!.result
  const glob = await call('glob', { pattern: '*.txt' })
  assert.equal(glob.isError, false)
  if (!glob.isError) { assert.match(JSON.stringify(glob.content), /1\/2/); assert.doesNotMatch(JSON.stringify(glob), /secret/) }
  const grep = await call('grep', { pattern: 'hello', include: '*.txt' })
  assert.equal(grep.isError, false)
  if (!grep.isError) { assert.match(JSON.stringify(grep.content), /1\/3/); assert.doesNotMatch(JSON.stringify(grep), /secret/) }
  const none = await call('grep', { pattern: 'no-match' })
  assert.equal(none.isError, false)
  if (!none.isError) assert.match(JSON.stringify(none.content), /未找到匹配/)
  for (const path of [outside, 'link']) {
    const denied = await call('grep', { pattern: 'secret', path })
    assert.equal(denied.isError, true)
    assert.doesNotMatch(JSON.stringify(denied), /secret\.txt|secret hello/)
  }
  const invalid = await call('grep', { pattern: '[' })
  assert.equal(invalid.isError, true)
  if (invalid.isError) assert.match(JSON.stringify(invalid), /搜索模式无效/)
  assert.equal((await call('grep', { pattern: 'hello', include: '*.txt,*.md' })).isError, true)
  assert.equal((await call('grep', { pattern: 'hello', include: '*.{txt,md}' })).isError, false)
  const backend = agent.context.fs
  const originalResolve = backend.resolve.bind(backend)
  const replacement = t.mock.method(backend, 'resolve', async (...[path, options]: Parameters<typeof backend.resolve>) => {
    if (path.endsWith('a.txt')) return originalResolve(join(outside, 'secret.txt'), options)
    return originalResolve(path, options)
  })
  const changed = await call('grep', { pattern: 'hello' })
  assert.equal(changed.isError, true)
  assert.doesNotMatch(JSON.stringify(changed), /hello one|secret\.txt/)
  replacement.mock.restore()
  await framework.manager.dispose('searcher')
  assert.equal(agent.context.get('tools'), undefined)
})
