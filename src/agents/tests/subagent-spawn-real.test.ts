import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { test } from 'node:test'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@fly-novel/llm'
import { bootstrapAgents } from '../core/bootstrap.js'
import { createSpawnAgentCreator, type SpawnPresetConfigs } from '../runtime/subagent-in-process-creator.js'
import { createTestAgent, withAgentLoop } from './agent-loop-fixtures.js'

class CaptureAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, block: 'text' }
    yield { type: 'text-delta', index: 0, text: '子任务完成' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '子任务完成' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function modelConfig(adapter: LlmAdapter): Record<string, unknown> {
  return { 'agent-loop-runtime': { provider: 'child', model: 'model' }, llm: { adapters: [{ providers: ['child'], adapter }] } }
}

test('正式 Spawn 按 Preset 创建独立子 Agent，任务与父历史隔离', async () => {
  const framework = await bootstrapAgents()
  const character = new CaptureAdapter()
  const director = new CaptureAdapter()
  const configs: SpawnPresetConfigs = { 'character-agent': modelConfig(character), 'director-agent': modelConfig(director) }
  const create = createSpawnAgentCreator(framework, configs)
  framework.presets.register({ id: 'real-spawn-parent', version: '1', role: 'character', plugins: withAgentLoop([
    { pluginId: 'tools' }, { pluginId: 'subagent' }, { pluginId: 'subagent-spawn-in-process' },
  ]) })
  try {
    const parent = await createTestAgent(framework, { id: 'real-parent', presetId: 'real-spawn-parent', pluginConfigs: {
      'subagent-spawn-in-process': { create },
    } })
    await parent.run({ prompt: '父历史独有内容' })
    const parentSession = parent.context.sessions.list()[0]!
    const parentSize = parentSession.size
    const input = { parent, prompt: '子任务原文', signal: new AbortController().signal }
    const runs = await Promise.all([
      parent.context.subagents.start('spawn', { ...input, presetId: 'character-agent' }),
      parent.context.subagents.start('spawn', { ...input, presetId: 'character-agent' }),
      parent.context.subagents.start('spawn', { ...input, presetId: 'director-agent' }),
    ])
    const children = framework.manager.list().filter(agent => agent.info.identity.id !== parent.info.identity.id)
    assert.equal(children.length, 3)
    assert.deepEqual(children.map(child => child.info.presetId).sort(), ['character-agent', 'character-agent', 'director-agent'])
    assert.equal(new Set(runs.map(run => run.id)).size, 3)
    const ids = children.map(child => child.context.sessions.list()[0]!.id)
    assert.equal(new Set([...ids, parentSession.id]).size, 4)
    assert.ok(children.every(child => child.context.get('tools') === undefined))
    assert.deepEqual(await Promise.all(runs.map(run => run.result)), Array.from({ length: 3 }, () => ({ output: '子任务完成', stopReason: 'completed' })))
    for (const call of [...character.requests, ...director.requests]) {
      assert.match(JSON.stringify(call.messages), /子任务原文/)
      assert.doesNotMatch(JSON.stringify(call.messages), /父历史独有内容/)
    }
    assert.equal(character.requests.length, 2)
    assert.equal(director.requests.length, 1)
    assert.match(JSON.stringify(character.requests[0]!.messages), /角色扮演 Agent/)
    assert.match(JSON.stringify(director.requests[0]!.messages), /小说导演 Agent/)
    assert.equal(parentSession.size, parentSize)
    await Promise.all(runs.map(run => run.dispose()))
    assert.deepEqual(framework.manager.list().map(agent => agent.info.identity.id), ['real-parent'])
  } finally {
    await framework.manager.disposeAll()
  }
})

test('选择和初始化失败不会向 Manager 留下子 Agent', async () => {
  const framework = await bootstrapAgents()
  const configs: SpawnPresetConfigs = {
    'character-agent': { 'agent-loop-runtime': { provider: 'child', model: 'model', sessionId: 'existing' }, llm: {} },
    'director-agent': { 'agent-loop-runtime': { provider: 'child', model: 'model' }, llm: {} },
  }
  const create = createSpawnAgentCreator(framework, configs)
  framework.presets.register({ id: 'reject-spawn-parent', version: '1', role: 'character', plugins: withAgentLoop([
    { pluginId: 'subagent' }, { pluginId: 'subagent-spawn-in-process' },
  ]) })
  try {
    const parent = await createTestAgent(framework, { id: 'reject-parent', presetId: 'reject-spawn-parent', pluginConfigs: { 'subagent-spawn-in-process': { create } } })
    const input = { parent, prompt: '任务', signal: new AbortController().signal }
    await assert.rejects(parent.context.subagents.start('spawn', { ...input, presetId: 'unknown' }), /尚未注册/)
    await assert.rejects(parent.context.subagents.start('spawn', { ...input, presetId: 'writer-agent' }), /未配置委派能力/)
    await assert.rejects(parent.context.subagents.start('spawn', { ...input, presetId: 'character-agent' }), /持久化 Session/)
    await assert.rejects(parent.context.subagents.start('spawn', { ...input, presetId: 'director-agent' }), /LLM/)
    assert.deepEqual(framework.manager.list().map(agent => agent.info.identity.id), ['reject-parent'])
  } finally {
    await framework.manager.disposeAll()
  }
})

test('子 Agent ID 冲突时不会释放已有 Agent', async t => {
  const framework = await bootstrapAgents()
  const create = createSpawnAgentCreator(framework, { 'character-agent': modelConfig(new CaptureAdapter()) })
  framework.presets.register({ id: 'collision-parent', version: '1', role: 'character', plugins: withAgentLoop([
    { pluginId: 'subagent' }, { pluginId: 'subagent-spawn-in-process' },
  ]) })
  try {
    const parent = await createTestAgent(framework, { id: 'subagent-collision', presetId: 'collision-parent', pluginConfigs: { 'subagent-spawn-in-process': { create } } })
    t.mock.method(crypto, 'randomUUID', () => 'collision')
    await assert.rejects(parent.context.subagents.start('spawn', {
      parent, presetId: 'character-agent', prompt: '任务', signal: new AbortController().signal,
    }), /已存在/)
    assert.equal(framework.manager.get('subagent-collision'), parent)
  } finally {
    t.mock.restoreAll()
    await framework.manager.disposeAll()
  }
})
