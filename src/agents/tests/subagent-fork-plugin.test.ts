import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LlmAdapter, type GenerateOptions, type StreamChunk, type ToolCallId } from '@fly-novel/llm'
import { bootstrapAgents } from '../core/bootstrap.js'
import { createForkAgentCreator } from '../runtime/subagent-in-process-creator.js'
import { SubagentRuntime } from '@fly-novel/subagent'
import { createTestAgent, EchoLlmAdapter, withAgentLoop } from './agent-loop-fixtures.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(accept => { resolve = accept })
  return { promise, resolve }
}

class WaitingAdapter extends LlmAdapter {
  readonly entered = deferred()
  readonly release = deferred()
  readonly requests: GenerateOptions[] = []
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    this.entered.resolve()
    await this.release.promise
    yield { type: 'block-start', index: 0, block: 'text' }
    yield { type: 'text-delta', index: 0, text: '子任务结果' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '子任务结果' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

test('Fork Provider 捕获父历史并通过 Driver 运行和释放角色 Agent', { timeout: 3000 }, async () => {
  const framework = await bootstrapAgents()
  const adapter = new WaitingAdapter()
  const create = createForkAgentCreator(framework, { 'character-agent': {
    'agent-loop-runtime': { provider: 'child', model: 'model' }, llm: { adapters: [{ providers: ['child'], adapter }] },
  } })
  framework.presets.register({ id: 'fork-parent', version: '1', role: 'general', plugins: withAgentLoop([
    { pluginId: 'subagent' }, { pluginId: 'subagent-fork-in-process' },
  ]) })
  try {
    const parent = await createTestAgent(framework, { id: 'parent', presetId: 'fork-parent', pluginConfigs: { 'subagent-fork-in-process': { create } } })
    await parent.run({ prompt: '已结束的历史' })
    const run = await parent.context.subagents.start('fork', { parent, presetId: 'character-agent', prompt: '子任务原文', parameters: { characterId: 'role-a' }, signal: new AbortController().signal })
    await adapter.entered.promise
    const child = framework.manager.list().find(agent => agent !== parent)!
    assert.equal(child.info.presetId, 'character-agent')
    assert.equal(child.info.parameters.characterId, 'role-a')
    assert.notEqual(child.context.sessions.list()[0]!.id, parent.context.sessions.list()[0]!.id)
    assert.match(JSON.stringify(adapter.requests[0]!.messages), /已结束的历史/)
    assert.match(JSON.stringify(adapter.requests[0]!.messages), /子任务原文/)
    let completed = false
    void run.result.then(() => { completed = true })
    await Promise.resolve()
    assert.equal(completed, false)
    await parent.run({ prompt: '父会话之后的新内容' })
    assert.doesNotMatch(JSON.stringify(child.context.sessions.list()[0]!.read()), /父会话之后的新内容/)
    adapter.release.resolve()
    assert.deepEqual(await run.result, { output: '子任务结果', stopReason: 'completed' })
    await run.dispose()
    assert.deepEqual(framework.manager.list().map(agent => agent.info.identity.id), ['parent'])
  } finally { adapter.release.resolve(); await framework.manager.disposeAll() }
})

test('Fork 拒绝伪造父身份、无效类型与未配置的 Preset', async () => {
  const framework = await bootstrapAgents()
  const adapter = new EchoLlmAdapter()
  const create = createForkAgentCreator(framework, { 'character-agent': {
    'agent-loop-runtime': { provider: 'child', model: 'model' }, llm: { adapters: [{ providers: ['child'], adapter }] },
  } })
  framework.presets.register({ id: 'fork-parent', version: '1', role: 'general', plugins: withAgentLoop([
    { pluginId: 'subagent' }, { pluginId: 'subagent-fork-in-process' },
  ]) })
  try {
    const parent = await createTestAgent(framework, { id: 'parent', presetId: 'fork-parent', pluginConfigs: { 'subagent-fork-in-process': { create } } })
    const base = { parent, prompt: '任务', signal: new AbortController().signal }
    await assert.rejects(parent.context.subagents.start('fork', { ...base, parent: { info: { identity: { id: 'other' } } }, presetId: 'character-agent' }), /同一父 Agent/)
    await assert.rejects(parent.context.subagents.start('fork', { ...base, presetId: ' character-agent' }), /Preset ID/)
    await assert.rejects(parent.context.subagents.start('fork', { ...base, presetId: 'generic-subagent' }), /未配置/)
    const provider = parent.context.subagents.getProvider('fork')!
    assert.throws(() => parent.context.subagents.registerProvider(provider), /已注册/)
    const session = parent.context.sessions.list()[0]!
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('tool/call', { turn: 1, step: 1, callId: 'call' as ToolCallId, name: 'tool', arguments: '{}' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await assert.rejects(parent.context.subagents.start('fork', { ...base, presetId: 'character-agent' }), /不支持的事件/)
    assert.deepEqual(framework.manager.list().map(agent => agent.info.identity.id), ['parent'])
  } finally { await framework.manager.disposeAll() }
})

test('Fork 不使用从根 Context 继承的 SubAgent 服务', async () => {
  const framework = await bootstrapAgents()
  const root = new SubagentRuntime()
  const rootScope = framework.context.plugin(ctx => { ctx.provide('subagents', root) })
  await rootScope
  const create = createForkAgentCreator(framework, {})
  framework.presets.register({ id: 'fork-inherited', version: '1', role: 'general', plugins: withAgentLoop([
    { pluginId: 'subagent-fork-in-process' },
  ]) })
  try {
    const parent = await createTestAgent(framework, { id: 'parent', presetId: 'fork-inherited', pluginConfigs: { 'subagent-fork-in-process': { create } } })
    await assert.rejects(parent.context.subagents.start('fork', { parent, presetId: 'character-agent', prompt: '任务', signal: new AbortController().signal }), /同一父 Agent/)
    assert.deepEqual(framework.manager.list().map(agent => agent.info.identity.id), ['parent'])
  } finally { await framework.manager.disposeAll(); await root.dispose(); await rootScope.dispose() }
})
