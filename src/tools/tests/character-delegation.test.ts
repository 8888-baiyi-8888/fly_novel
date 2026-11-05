import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LlmAdapter, type GenerateOptions, type StreamChunk, type ToolCallId } from '@fly-novel/llm'
import { SubagentRuntime, subagentRunId } from '@fly-novel/subagent'
import { bootstrapAgents } from '../../agents/core/bootstrap.js'
import { createSpawnAgentCreator } from '../../agents/runtime/subagent-in-process-creator.js'
import { createTestAgent, withAgentLoop } from '../../agents/tests/agent-loop-fixtures.js'
import { createCharacterDelegationTool } from '../index.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(accept => { resolve = accept })
  return { promise, resolve }
}

class GatedAdapter extends LlmAdapter {
  readonly entered = deferred()
  readonly finish = deferred()
  readonly requests: GenerateOptions[] = []
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.requests.length === 2) this.entered.resolve()
    await this.finish.promise
    yield { type: 'block-start', index: 0, block: 'text' }
    yield { type: 'text-delta', index: 0, text: '角色任务完成' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '角色任务完成' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

test('父 Agent 通过模型工具调用角色工具并获得结果', async () => {
  class ParentAdapter extends LlmAdapter {
    readonly requests: GenerateOptions[] = []
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      this.requests.push(options)
      if (this.requests.length === 1) {
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'character' as ToolCallId, name: 'delegate_character', arguments: '{"task":"角色任务","characterId":"character-a"}' } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '收到结果' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
  class ChildAdapter extends LlmAdapter {
    override async *stream(): AsyncIterable<StreamChunk> {
      yield { type: 'block-start', index: 0, block: 'text' }
      yield { type: 'text-delta', index: 0, text: '角色任务完成' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '角色任务完成' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  const framework = await bootstrapAgents()
  const adapter = new ParentAdapter()
  const create = createSpawnAgentCreator(framework, { 'character-agent': {
    'agent-loop-runtime': { provider: 'child', model: 'model' }, llm: { adapters: [{ providers: ['child'], adapter: new ChildAdapter() }] },
  } })
  framework.presets.register({ id: 'character-model-parent', version: '1', role: 'general', plugins: withAgentLoop([
    { pluginId: 'tools' }, { pluginId: 'subagent' }, { pluginId: 'subagent-spawn-in-process' },
  ]) })
  try {
    const parent = await createTestAgent(framework, { id: 'parent', presetId: 'character-model-parent', pluginConfigs: {
      'agent-loop-runtime': { provider: 'parent', model: 'model', workingDirectory: process.cwd() },
      llm: { adapters: [{ providers: ['parent'], adapter }] }, 'subagent-spawn-in-process': { create },
    } })
    parent.context.tools.register(createCharacterDelegationTool(parent.context.subagents, parent.info.identity.id))
    assert.deepEqual(await parent.run({ prompt: '请委派角色任务' }), { content: '收到结果' })
    const result = adapter.requests[1]?.messages.at(-1)?.content[0]
    assert.ok(result?.type === 'tool-result')
    assert.equal(result.isError, false)
    assert.deepEqual(result.content, [{ type: 'text', text: '角色任务完成' }])
    assert.deepEqual(framework.manager.list().map(agent => agent.info.identity.id), ['parent'])
  } finally { await framework.manager.disposeAll() }
})

test('独立角色工具将不同 ID 传给各自子 Agent，并等待结果和释放', { timeout: 3000 }, async () => {
  const framework = await bootstrapAgents()
  const adapter = new GatedAdapter()
  const create = createSpawnAgentCreator(framework, { 'character-agent': {
    'agent-loop-runtime': { provider: 'child', model: 'model' }, llm: { adapters: [{ providers: ['child'], adapter }] },
  } })
  framework.presets.register({ id: 'character-delegate-parent', version: '1', role: 'general', plugins: withAgentLoop([
    { pluginId: 'tools' }, { pluginId: 'subagent' }, { pluginId: 'subagent-spawn-in-process' },
  ]) })
  try {
    const parent = await createTestAgent(framework, { id: 'parent', presetId: 'character-delegate-parent', pluginConfigs: { 'subagent-spawn-in-process': { create } } })
    const unregister = parent.context.tools.register(createCharacterDelegationTool(parent.context.subagents, parent.info.identity.id))
    const call = (id: string, characterId: string) => parent.context.tools.execute({
      calls: [{ type: 'tool-call', id: id as ToolCallId, name: 'delegate_character', arguments: JSON.stringify({ characterId, task: '  角色任务  ' }) }],
      signal: new AbortController().signal, workingDirectory: process.cwd(),
    })
    const first = call('first', 'character-a')
    const second = call('second', 'character-b')
    await adapter.entered.promise
    const children = framework.manager.list().filter(agent => agent !== parent)
    assert.equal(children.length, 2)
    assert.deepEqual(children.map(agent => agent.info.parameters.characterId).sort(), ['character-a', 'character-b'])
    assert.ok(children.every(agent => agent.info.presetId === 'character-agent'))
    assert.equal(new Set(children.map(agent => agent.context.sessions.list()[0]!.id)).size, 2)
    for (const request of adapter.requests) {
      assert.match(JSON.stringify(request.messages), /  角色任务  /)
      assert.doesNotMatch(JSON.stringify(request.messages), /character-a|character-b/)
    }
    adapter.finish.resolve()
    for (const response of await Promise.all([first, second])) {
      const result = response.results[0]!.result
      assert.equal(result.isError, false)
      if (!result.isError) assert.equal(result.value, '角色任务完成')
    }
    assert.deepEqual(framework.manager.list().map(agent => agent.info.identity.id), ['parent'])
    unregister()
    assert.equal(parent.context.tools.get('delegate_character'), undefined)
  } finally { adapter.finish.resolve(); await framework.manager.disposeAll() }
})

test('角色工具拒绝无效 ID；不支持创建参数的 Provider 不能静默忽略', async () => {
  const service = new SubagentRuntime()
  let called = false
  service.registerProvider({ name: 'spawn', async start() { called = true; throw new Error('不应调用') } })
  try {
    await assert.rejects(service.start('spawn', { parent: { info: { identity: { id: 'parent' } } }, prompt: '任务', signal: new AbortController().signal, parameters: { characterId: 'a' } }), /不支持创建参数/)
    assert.equal(called, false)
    const tool = createCharacterDelegationTool(service, 'parent')
    const context = { callId: 'test' as ToolCallId, name: 'delegate_character', agent: { id: 'parent', name: 'parent', role: 'general' }, signal: new AbortController().signal, workingDirectory: process.cwd() }
    for (const args of [{ task: '任务' }, { task: '任务', characterId: '' }, { task: '任务', characterId: ' a' }]) {
      await assert.rejects(tool.execute(args, context))
    }
    assert.equal(called, false)
  } finally { await service.dispose() }
})

test('角色工具同时保留执行和释放失败', async () => {
  const service = new SubagentRuntime()
  let released = false
  service.registerProvider({ name: 'spawn', supportsParameters: true, async start() {
    return { id: subagentRunId('run'), result: Promise.resolve({ output: '', stopReason: 'error', errorCode: 'FAILED' }),
      async dispose() { released = true; throw new Error('模拟释放失败') } }
  } })
  try {
    const tool = createCharacterDelegationTool(service, 'parent')
    await assert.rejects(tool.execute({ task: '任务', characterId: 'a' }, {
      callId: 'test' as ToolCallId, name: 'delegate_character', agent: { id: 'parent', name: 'parent', role: 'general' },
      signal: new AbortController().signal, workingDirectory: process.cwd(),
    }), error => {
      assert.ok(error instanceof AggregateError)
      assert.match(String(error.errors[0]), /角色子任务执行失败.*FAILED/)
      assert.match(String(error.errors[1]), /模拟释放失败/)
      return true
    })
    assert.equal(released, true)
  } finally { await service.dispose() }
})

test('执行期间注销角色工具不影响已启动任务，结束后释放子 Agent', { timeout: 3000 }, async () => {
  const entered = deferred()
  const finish = deferred()
  class WaitingAdapter extends LlmAdapter {
    override async *stream(): AsyncIterable<StreamChunk> {
      entered.resolve()
      await finish.promise
      yield { type: 'block-start', index: 0, block: 'text' }
      yield { type: 'text-delta', index: 0, text: '任务完成' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '任务完成' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  const framework = await bootstrapAgents()
  const create = createSpawnAgentCreator(framework, { 'character-agent': {
    'agent-loop-runtime': { provider: 'child', model: 'model' }, llm: { adapters: [{ providers: ['child'], adapter: new WaitingAdapter() }] },
  } })
  framework.presets.register({ id: 'character-unregister-parent', version: '1', role: 'general', plugins: withAgentLoop([
    { pluginId: 'tools' }, { pluginId: 'subagent' }, { pluginId: 'subagent-spawn-in-process' },
  ]) })
  try {
    const parent = await createTestAgent(framework, { id: 'parent', presetId: 'character-unregister-parent', pluginConfigs: { 'subagent-spawn-in-process': { create } } })
    const unregister = parent.context.tools.register(createCharacterDelegationTool(parent.context.subagents, parent.info.identity.id))
    const running = parent.context.tools.execute({ calls: [{ type: 'tool-call', id: 'running' as ToolCallId, name: 'delegate_character', arguments: '{"task":"任务","characterId":"character-a"}' }], signal: new AbortController().signal, workingDirectory: process.cwd() })
    await entered.promise
    assert.equal(framework.manager.list().length, 2)
    unregister()
    assert.equal(parent.context.tools.get('delegate_character'), undefined)
    assert.equal(framework.manager.list().length, 2)
    finish.resolve()
    const result = (await running).results[0]!.result
    assert.equal(result.isError, false)
    if (!result.isError) assert.equal(result.value, '任务完成')
    assert.deepEqual(framework.manager.list().map(agent => agent.info.identity.id), ['parent'])
  } finally { finish.resolve(); await framework.manager.disposeAll() }
})

test('取消角色委派会取消子任务并释放实例', { timeout: 3000 }, async () => {
  const entered = deferred()
  class WaitingAdapter extends LlmAdapter {
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      const signal = options.signal
      if (!signal) throw new Error('测试缺少取消信号')
      entered.resolve()
      if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      yield { type: 'finish', reason: { kind: 'aborted', failure: { message: '取消', code: 'ABORTED' } } }
    }
  }
  const framework = await bootstrapAgents()
  const create = createSpawnAgentCreator(framework, { 'character-agent': {
    'agent-loop-runtime': { provider: 'child', model: 'model' }, llm: { adapters: [{ providers: ['child'], adapter: new WaitingAdapter() }] },
  } })
  framework.presets.register({ id: 'character-cancel-parent', version: '1', role: 'general', plugins: withAgentLoop([
    { pluginId: 'tools' }, { pluginId: 'subagent' }, { pluginId: 'subagent-spawn-in-process' },
  ]) })
  try {
    const parent = await createTestAgent(framework, { id: 'parent', presetId: 'character-cancel-parent', pluginConfigs: { 'subagent-spawn-in-process': { create } } })
    parent.context.tools.register(createCharacterDelegationTool(parent.context.subagents, parent.info.identity.id))
    const controller = new AbortController()
    const running = parent.context.tools.execute({ calls: [{ type: 'tool-call', id: 'cancel' as ToolCallId, name: 'delegate_character', arguments: '{"task":"任务","characterId":"character-a"}' }], signal: controller.signal, workingDirectory: process.cwd() })
    await entered.promise
    controller.abort()
    const result = (await running).results[0]!.result
    assert.equal(result.isError, true)
    if (result.isError) assert.equal(result.error.info.code, 'ABORTED')
    assert.deepEqual(framework.manager.list().map(agent => agent.info.identity.id), ['parent'])
  } finally { await framework.manager.disposeAll() }
})
