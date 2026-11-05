import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LlmAdapter, createAssistantMessage, type GenerateOptions, type StreamChunk } from '@fly-novel/llm'
import { bootstrapAgents } from '../core/bootstrap.js'
import { createForkAgentCreator, createSpawnAgentCreator } from '../runtime/subagent-in-process-creator.js'
import { createTestAgent, withAgentLoop } from './agent-loop-fixtures.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(accept => { resolve = accept })
  return { promise, resolve }
}

class ParentAdapter extends LlmAdapter {
  private count = 0
  readonly entered = deferred()
  readonly release = deferred()
  override async *stream(): AsyncIterable<StreamChunk> {
    this.count++
    if (this.count === 3) { this.entered.resolve(); await this.release.promise }
    yield { type: 'block-start', index: 0, block: 'text' }
    yield { type: 'text-delta', index: 0, text: '父回复' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '父回复' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class ChildAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly entered = deferred()
  readonly release = deferred()
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.requests.length === 3) this.entered.resolve()
    const signal = options.signal!
    if (!signal.aborted) await Promise.race([this.release.promise, new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))])
    if (signal.aborted) {
      yield { type: 'finish', reason: { kind: 'aborted', failure: { message: '取消', code: 'ABORTED' } } }
      return
    }
    const prompt = JSON.stringify(options.messages.at(-1))
    const output = prompt.includes('空输出任务') ? '' : '子回复'
    if (output) {
      yield { type: 'block-start', index: 0, block: 'text' }
      yield { type: 'text-delta', index: 0, text: output }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: output } }
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

test('同一父会话对照 Spawn 与不同类型 Fork 的历史、隔离和结果', { timeout: 5000 }, async () => {
  const framework = await bootstrapAgents()
  const parentAdapter = new ParentAdapter()
  const childAdapter = new ChildAdapter()
  const childConfig = { 'agent-loop-runtime': { provider: 'child', model: 'child-model' }, llm: { adapters: [{ providers: ['child'], adapter: childAdapter }] } }
  const configs = { 'generic-subagent': childConfig, 'character-agent': childConfig }
  const fork = createForkAgentCreator(framework, configs)
  const spawn = createSpawnAgentCreator(framework, configs)
  framework.presets.register({ id: 'comparison-parent', version: '1', role: 'general', plugins: withAgentLoop([
    { pluginId: 'subagent' }, { pluginId: 'subagent-fork-in-process' }, { pluginId: 'subagent-spawn-in-process' },
  ]) })
  try {
    const parent = await createTestAgent(framework, { id: 'parent', presetId: 'comparison-parent', pluginConfigs: {
      'agent-loop-runtime': { provider: 'parent', model: 'parent-model' }, llm: { adapters: [{ providers: ['parent'], adapter: parentAdapter }] },
      'subagent-fork-in-process': { create: fork }, 'subagent-spawn-in-process': { create: spawn },
    } })
    await parent.run({ prompt: '第一轮历史' })
    await parent.run({ prompt: '第二轮历史' })
    const active = parent.run({ prompt: '进行中的第三轮' })
    await parentAdapter.entered.promise
    const controller = new AbortController()
    const base = { parent, signal: new AbortController().signal }
    const runs = await Promise.all([
      parent.context.subagents.start('spawn', { ...base, presetId: 'generic-subagent', prompt: 'Spawn任务' }),
      parent.context.subagents.start('fork', { ...base, presetId: 'generic-subagent', prompt: '空输出任务' }),
      parent.context.subagents.start('fork', { ...base, presetId: 'character-agent', prompt: '角色任务', parameters: { characterId: 'role-a' }, signal: controller.signal }),
    ])
    await childAdapter.entered.promise
    const children = framework.manager.list().filter(agent => agent !== parent)
    assert.equal(children.length, 3)
    assert.equal(new Set(runs.map(run => run.id)).size, 3)
    assert.equal(new Set(framework.manager.list().map(agent => agent.info.identity.id)).size, 4)
    assert.equal(new Set(framework.manager.list().map(agent => agent.context.sessions.list()[0]!.id)).size, 4)
    assert.equal(children.find(agent => agent.info.presetId === 'character-agent')!.info.parameters.characterId, 'role-a')
    for (const request of childAdapter.requests) {
      const messages = JSON.stringify(request.messages)
      assert.equal(request.provider, 'child')
      assert.equal(request.model, 'child-model')
      assert.doesNotMatch(messages, /进行中的第三轮/)
      if (messages.includes('Spawn任务')) assert.doesNotMatch(messages, /第一轮历史|第二轮历史/)
      else { assert.match(messages, /第一轮历史/); assert.match(messages, /第二轮历史/) }
      const system = JSON.stringify(request.messages[0])
      if (messages.includes('角色任务')) assert.match(system, /角色扮演 Agent/)
      else assert.match(system, /通用任务 Agent/)
      assert.doesNotMatch(messages, /role-a/)
    }
    const parentSession = parent.context.sessions.list()[0]!
    assert.doesNotMatch(JSON.stringify(parentSession.read()), /Spawn任务|空输出任务|角色任务/)
    controller.abort()
    assert.deepEqual(await runs[2]!.result, { output: '', stopReason: 'aborted' })
    parentAdapter.release.resolve()
    await active
    assert.ok(children.every(child => !JSON.stringify(child.context.sessions.list()[0]!.read()).includes('进行中的第三轮')))
    childAdapter.release.resolve()
    assert.deepEqual(await runs[0]!.result, { output: '子回复', stopReason: 'completed' })
    assert.deepEqual(await runs[1]!.result, { output: '', stopReason: 'completed' })
    await Promise.all(runs.map(run => run.dispose()))
    const later = await parent.context.subagents.start('fork', { ...base, presetId: 'generic-subagent', prompt: '后续任务' })
    assert.ok(!runs.some(run => run.id === later.id))
    await later.result
    assert.match(JSON.stringify(childAdapter.requests[3]!.messages), /进行中的第三轮/)
    await later.dispose()
    assert.deepEqual(framework.manager.list().map(agent => agent.info.identity.id), ['parent'])
  } finally { parentAdapter.release.resolve(); childAdapter.release.resolve(); await framework.manager.disposeAll() }
})

test('正式 Fork 拒绝父历史中的模型私有重放状态', async () => {
  const framework = await bootstrapAgents()
  const adapter = new ChildAdapter()
  const configs = { 'generic-subagent': { 'agent-loop-runtime': { provider: 'child', model: 'model' }, llm: { adapters: [{ providers: ['child'], adapter }] } } }
  framework.presets.register({ id: 'replay-parent', version: '1', role: 'general', plugins: withAgentLoop([
    { pluginId: 'subagent' }, { pluginId: 'subagent-fork-in-process' },
  ]) })
  try {
    const parent = await createTestAgent(framework, { id: 'parent', presetId: 'replay-parent', pluginConfigs: {
      'subagent-fork-in-process': { create: createForkAgentCreator(framework, configs) },
    } })
    const session = parent.context.sessions.list()[0]!
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/message', { turn: 1, step: 1, message: createAssistantMessage({
      source: { provider: 'parent', model: 'model', replayState: { private: true } }, content: [{ type: 'text', text: '历史' }],
    }) })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await assert.rejects(parent.context.subagents.start('fork', { parent, presetId: 'generic-subagent', prompt: '任务', signal: new AbortController().signal }), /重放状态/)
    assert.deepEqual(framework.manager.list().map(agent => agent.info.identity.id), ['parent'])
    assert.equal(adapter.requests.length, 0)
  } finally { adapter.release.resolve(); await framework.manager.disposeAll() }
})
