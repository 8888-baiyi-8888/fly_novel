import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@fly-novel/llm'
import { bootstrapAgents } from '../core/bootstrap.js'
import { createSpawnAgentCreator } from '../runtime/subagent-in-process-creator.js'
import { genericSubagentPreset } from '../generic-subagent/preset.js'
import { createTestAgent, withAgentLoop } from './agent-loop-fixtures.js'

class CaptureAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, block: 'text' }
    yield { type: 'text-delta', index: 0, text: '任务完成' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '任务完成' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

test('可信代码通过正式 Spawn 创建通用子 Agent 并接收结果', async () => {
  const framework = await bootstrapAgents()
  const adapter = new CaptureAdapter()
  const create = createSpawnAgentCreator(framework, { [genericSubagentPreset.id]: {
    'agent-loop-runtime': { provider: 'child', model: 'test-model' },
    llm: { adapters: [{ providers: ['child'], adapter }] },
  } })
  framework.presets.register({ id: 'generic-test-parent', version: '1', role: 'character', plugins: withAgentLoop([
    { pluginId: 'subagent' }, { pluginId: 'subagent-spawn-in-process' },
  ]) })
  try {
    const parent = await createTestAgent(framework, { id: 'parent', presetId: 'generic-test-parent', pluginConfigs: { 'subagent-spawn-in-process': { create } } })
    await parent.run({ prompt: '仅父会话的历史' })
    const parentSession = parent.context.sessions.list()[0]!
    const parentSize = parentSession.size
    const input = { parent, presetId: genericSubagentPreset.id, prompt: '  原始任务  ', signal: new AbortController().signal }
    const runs = await Promise.all([parent.context.subagents.start('spawn', input), parent.context.subagents.start('spawn', input)])
    const children = framework.manager.list().filter(agent => agent !== parent)
    assert.equal(children.length, 2)
    assert.ok(children.every(agent => agent.info.presetId === genericSubagentPreset.id && agent.info.identity.role === 'general'))
    assert.ok(children.every(agent => agent.context.get('tools') === undefined))
    assert.equal(new Set([parentSession.id, ...children.map(agent => agent.context.sessions.list()[0]!.id)]).size, 3)
    assert.deepEqual(await Promise.all(runs.map(run => run.result)), [
      { output: '任务完成', stopReason: 'completed' }, { output: '任务完成', stopReason: 'completed' },
    ])
    assert.equal(adapter.requests.length, 2)
    for (const request of adapter.requests) {
      const messages = JSON.stringify(request.messages)
      assert.match(messages, /通用任务 Agent/)
      assert.match(messages, /  原始任务  /)
      assert.doesNotMatch(messages, /仅父会话的历史/)
    }
    assert.equal(parentSession.size, parentSize)
    await Promise.all(runs.map(run => run.dispose()))
    assert.deepEqual(framework.manager.list().map(agent => agent.info.identity.id), ['parent'])
  } finally { await framework.manager.disposeAll() }
})

test('通用子 Agent 缺少模型配置或预先取消时不留下实例', async () => {
  const framework = await bootstrapAgents()
  const create = createSpawnAgentCreator(framework, { [genericSubagentPreset.id]: {} })
  framework.presets.register({ id: 'generic-invalid-parent', version: '1', role: 'character', plugins: withAgentLoop([
    { pluginId: 'subagent' }, { pluginId: 'subagent-spawn-in-process' },
  ]) })
  try {
    const parent = await createTestAgent(framework, { id: 'parent', presetId: 'generic-invalid-parent', pluginConfigs: { 'subagent-spawn-in-process': { create } } })
    const input = { parent, presetId: genericSubagentPreset.id, prompt: '任务', signal: new AbortController().signal }
    await assert.rejects(parent.context.subagents.start('spawn', input), /缺少 Agent Loop 配置/)
    const cancelled = new AbortController()
    cancelled.abort(new Error('提前取消'))
    await assert.rejects(parent.context.subagents.start('spawn', { ...input, signal: cancelled.signal }), /提前取消/)
    assert.deepEqual(framework.manager.list().map(agent => agent.info.identity.id), ['parent'])
  } finally { await framework.manager.disposeAll() }
})
