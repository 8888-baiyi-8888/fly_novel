import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { bootstrapAgents, type Agent } from '@fly-novel/agents'
import { LlmAdapter, type GenerateOptions, type StreamChunk, type ToolCallId } from '@fly-novel/llm'
import { sandboxPolicyPluginDefinition } from '@fly-novel/sandbox-policy'
import { fsObservationPolicyPluginDefinition } from '@fly-novel/fs-observation-policy'
import { toolFsPluginDefinition } from '@fly-novel/tool-fs'
import { toolFsSearchPluginDefinition } from '@fly-novel/tool-fs-search'
import { localSubprocessPluginDefinition } from '@fly-novel/subprocess-local'
import configured = require('../call-llm.js')
import { createWorldInitializationAgentWithWorldWorkspaces } from '../agents/index.js'
import { worldInitializationDraftFsPluginDefinition } from '../agents/world-initialization-draft-fs.js'
import type { WorldWorkspaceConfig } from '../../world-init/world-workspace-config.js'

class FixedAdapter extends LlmAdapter {
  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '完成' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

test('可信世界配置装配主 Agent 和第二个特殊 Agent 的真实文件工具边界', async t => {
  const parent = join(process.cwd(), 'tmp'); await mkdir(parent, { recursive: true })
  const root = await realpath(await mkdtemp(join(parent, 'world-assembly-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const makeWorld = async (worldId: string): Promise<WorldWorkspaceConfig> => {
    const readRoot = join(root, worldId)
    for (const dir of ['main', 'characters', 'other', 'confirmed', 'catalog']) await mkdir(join(readRoot, dir), { recursive: true })
    return { worldId, readRoot, confirmedRoot: join(readRoot, 'confirmed'), catalogRoot: join(readRoot, 'catalog'),
      mainAgent: { agentId: 'main', writableRoot: join(readRoot, 'main') }, agents: [
        { agentId: 'creator', writableRoot: join(readRoot, 'characters') }, { agentId: 'other', writableRoot: join(readRoot, 'other') },
      ] }
  }
  const a = await makeWorld('a'); const b = await makeWorld('b')
  await writeFile(join(a.agents[1]!.writableRoot, 'other.md'), 'other data\n')
  await writeFile(join(a.confirmedRoot, 'fact.md'), 'confirmed\n')
  await writeFile(join(a.catalogRoot, 'catalog.md'), 'catalog\n')
  await writeFile(join(b.mainAgent.writableRoot, 'secret.md'), 'secret\n')
  const adapter = new FixedAdapter()
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'test', adapter }))
  const deployment = { singleWriterProcess: true } as const
  const main = await createWorldInitializationAgentWithWorldWorkspaces([a, b], 'a', undefined, deployment)
  t.after(() => main.dispose())
  const framework = await bootstrapAgents()
  t.after(() => framework.manager.disposeAll())
  for (const plugin of [sandboxPolicyPluginDefinition, fsObservationPolicyPluginDefinition, toolFsPluginDefinition,
    toolFsSearchPluginDefinition, localSubprocessPluginDefinition, worldInitializationDraftFsPluginDefinition]) framework.plugins.register(plugin)
  const base = framework.presets.get('generic-subagent')
  framework.presets.register({ ...base, id: 'workspace-test-agent', plugins: [...base.plugins, { pluginId: 'tools' },
    { pluginId: 'sandbox-policy' }, { pluginId: 'world-initialization-draft-fs' }, { pluginId: 'fs-observation-policy' },
    { pluginId: 'subprocess-local' }, { pluginId: 'tool-fs' }, { pluginId: 'tool-fs-search' }] })
  const otherRoot = a.agents[1]!.writableRoot
  const other = await framework.manager.create({ id: 'other', presetId: 'workspace-test-agent', pluginConfigs: {
    'agent-loop-runtime': { provider: 'test', model: 'test', workingDirectory: a.readRoot },
    llm: { adapters: [{ providers: ['test'], adapter }] },
    'sandbox-policy': { mode: 'workspace-write', workspaceRoot: otherRoot },
    'world-initialization-draft-fs': { cwd: a.readRoot, draftRoot: otherRoot }, 'tool-fs': { applyPatch: true },
  } })
  const call = async (agent: Agent, name: string, args: object) => (await agent.context.tools.execute({
    calls: [{ type: 'tool-call', id: 'test' as ToolCallId, name, arguments: JSON.stringify(args) }],
    workingDirectory: a.readRoot, session: agent.context.sessions.list()[0]!, signal: new AbortController().signal,
  })).results[0]!.result
  assert.equal((await call(main, 'read', { file_path: 'other/other.md' })).isError, false)
  assert.equal((await call(other, 'write', { file_path: 'other/new.md', content: 'new' })).isError, false)
  assert.equal((await call(main, 'read', { file_path: 'other/new.md' })).isError, false)
  assert.equal((await call(main, 'write', { file_path: 'main/main.md', content: 'main' })).isError, false)
  assert.equal((await call(other, 'read', { file_path: 'main/main.md' })).isError, false)
  for (const target of ['other/other.md', 'characters/index.json', 'confirmed/fact.md', 'catalog/catalog.md', join(b.mainAgent.writableRoot, 'secret.md')]) {
    assert.equal((await call(main, 'write', { file_path: target, content: 'bad' })).isError, true, target)
  }
  assert.equal((await call(other, 'write', { file_path: 'main/main.md', content: 'bad' })).isError, true)
  assert.equal((await call(main, 'write', { file_path: join(tmpdir(), 'world-workspace-denied.txt'), content: 'bad' })).isError, true)
  assert.equal((await call(main, 'edit', { file_path: 'other/other.md', old_string: 'other', new_string: 'bad' })).isError, true)
  assert.equal((await call(main, 'read', { file_path: join(b.mainAgent.writableRoot, 'secret.md') })).isError, true)
  assert.equal((await call(main, 'grep', { pattern: 'secret', path: b.readRoot })).isError, true)
  const deniedPatch = await call(main, 'apply_patch', { input: '*** Begin Patch\n*** Delete File: other/other.md\n*** End Patch' })
  assert.match(JSON.stringify(deniedPatch), /FS_SANDBOX_DENIED/)
  const moveOut = await call(main, 'apply_patch', { input: '*** Begin Patch\n*** Update File: main/main.md\n*** Move to: other/moved.md\n@@\n-main\n+moved\n*** End Patch' })
  assert.match(JSON.stringify(moveOut), /FS_SANDBOX_DENIED/)
  const moveIn = await call(main, 'apply_patch', { input: '*** Begin Patch\n*** Update File: other/other.md\n*** Move to: main/moved.md\n@@\n-other data\n+moved\n*** End Patch' })
  assert.match(JSON.stringify(moveIn), /FS_SANDBOX_DENIED/)
  assert.equal(await readFile(join(a.agents[1]!.writableRoot, 'other.md'), 'utf8'), 'other data\n')
  assert.equal(await readFile(join(a.confirmedRoot, 'fact.md'), 'utf8'), 'confirmed\n')
  await assert.rejects(createWorldInitializationAgentWithWorldWorkspaces([a, b], 'missing', undefined, deployment), /世界配置不存在/)
  const sessionRoot = join(root, 'sessions'); await mkdir(sessionRoot)
  const creator = { agentId: 'main', sessionId: 's', sessionMode: 'create' as const, sessionRoot, initializeCharacters: true,
    provider: 'test', model: 'test', adapter, defaultCharacterCount: 2 }
  await assert.rejects(createWorldInitializationAgentWithWorldWorkspaces([a, b], 'a', creator, deployment), /身份不属于/)
  await assert.rejects(createWorldInitializationAgentWithWorldWorkspaces([a, b], 'a', { ...creator, agentId: 'creator', sessionRoot: b.mainAgent.writableRoot }, deployment), /任何世界/)
  class CharacterAdapter extends LlmAdapter {
    requests: GenerateOptions[] = []
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      this.requests.push(options)
      if (this.requests.length === 1) {
        const calls = [
          { id: 'search', name: 'grep', args: { pattern: 'other data', path: 'other' } },
          { id: 'outside', name: 'read', args: { file_path: join(b.mainAgent.writableRoot, 'secret.md') } },
          { id: 'create', name: 'character_create', args: { character: { name: '测试角色', summary: '角色建议', categories: {}, body: '设定' } } },
        ]
        for (const [index, item] of calls.entries()) yield { type: 'block-end', index, block: { type: 'tool-call', id: item.id as ToolCallId, name: item.name, arguments: JSON.stringify(item.args) } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '角色建议已保存' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
  const childAdapter = new CharacterAdapter()
  await main.dispose()
  const delegated = await createWorldInitializationAgentWithWorldWorkspaces([a, b], 'a', { ...creator, agentId: 'creator', adapter: childAdapter }, deployment)
  try {
    const result = await call(delegated, 'delegate_character_creator', { task: '搜索资料并创建角色' })
    assert.equal(result.isError, false)
    const blocks = childAdapter.requests[1]!.messages.flatMap(message => message.content)
    for (const [id, isError] of [['search', false], ['outside', true], ['create', false]] as const) {
      const block = blocks.find(item => item.type === 'tool-result' && item.toolCallId === id)
      assert.ok(block && block.type === 'tool-result')
      assert.equal(!!block.isError, isError, id)
    }
    assert.match(await readFile(join(a.agents[0]!.writableRoot, 'index.json'), 'utf8'), /测试角色/)
  } finally { await delegated.dispose() }
  const resumed = await createWorldInitializationAgentWithWorldWorkspaces([a, b], 'a', {
    ...creator, agentId: 'creator', adapter: childAdapter, sessionMode: 'resume', initializeCharacters: false,
  }, deployment)
  try {
    assert.equal((await call(resumed, 'delegate_character_creator', { task: '继续角色任务' })).isError, false)
    assert.match(JSON.stringify(childAdapter.requests[2]!.messages), /搜索资料并创建角色/)
    assert.match(await readFile(join(a.agents[0]!.writableRoot, 'index.json'), 'utf8'), /测试角色/)
  } finally { await resumed.dispose() }
})
