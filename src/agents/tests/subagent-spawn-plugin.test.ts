import assert from 'node:assert/strict'
import { test } from 'node:test'
import { subagentRunId, type SubagentStartRequest } from '@fly-novel/subagent'
import type { InProcessAgentCreator } from '@fly-novel/subagent-in-process-driver'
import { bootstrapAgents } from '../core/bootstrap.js'
import { createTestAgent, withAgentLoop } from './agent-loop-fixtures.js'

test('Spawn Provider 在各 Agent 作用域注册并传递类型和任务', async () => {
  const framework = await bootstrapAgents()
  const requests: SubagentStartRequest[] = []
  let releases = 0
  const create: InProcessAgentCreator = async request => {
    requests.push(request)
    return {
      id: subagentRunId(`run-${requests.length}`),
      agent: { async run({ prompt }) { return { content: prompt } }, cancel() {} },
      async dispose() { releases++ },
    }
  }
  framework.presets.register({ id: 'spawn-parent', version: '1', role: 'character', plugins: withAgentLoop([
    { pluginId: 'subagent' }, { pluginId: 'subagent-spawn-in-process' },
  ]) })
  try {
    const options = { presetId: 'spawn-parent', pluginConfigs: { 'subagent-spawn-in-process': { create } } }
    const first = await createTestAgent(framework, { id: 'spawn-parent-1', ...options })
    const second = await createTestAgent(framework, { id: 'spawn-parent-2', ...options })
    const service = first.context.subagents
    const other = second.context.subagents
    assert.notEqual(service, other)
    assert.ok(service.getProvider('spawn'))
    assert.ok(other.getProvider('spawn'))
    assert.throws(() => service.registerProvider({ name: 'spawn', async start() { throw new Error('不可调用') } }), /已注册/)
    const base = { parent: first, prompt: '原始任务', signal: new AbortController().signal }
    for (const presetId of [undefined, '', '   ', ' character-agent']) {
      await assert.rejects(service.start('spawn', { ...base, presetId }), /Preset ID/)
    }
    assert.equal(requests.length, 0)
    const run = await service.start('spawn', { ...base, presetId: 'character-agent' })
    assert.equal(requests[0].presetId, 'character-agent')
    assert.equal(requests[0].parent, first)
    assert.deepEqual(await run.result, { output: '原始任务', stopReason: 'completed' })
    await framework.manager.dispose('spawn-parent-1')
    assert.throws(() => service.getProvider('spawn'), /已关闭/)
    assert.ok(other.getProvider('spawn'))
    assert.equal(releases, 0)
    await run.dispose()
    await run.dispose()
    assert.equal(releases, 1)
  } finally {
    await framework.manager.disposeAll()
  }
})

test('Spawn 插件拒绝缺少创建函数的配置', async () => {
  const framework = await bootstrapAgents()
  framework.presets.register({ id: 'spawn-invalid', version: '1', role: 'character', plugins: withAgentLoop([
    { pluginId: 'subagent' }, { pluginId: 'subagent-spawn-in-process' },
  ]) })
  try {
    await assert.rejects(createTestAgent(framework, { id: 'invalid', presetId: 'spawn-invalid' }), /创建函数/)
    assert.equal(framework.manager.list().length, 0)
  } finally {
    await framework.manager.disposeAll()
  }
})
