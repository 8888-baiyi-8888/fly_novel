import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LlmAdapter, type GenerateOptions, type StreamChunk, type ToolCallId } from '@fly-novel/llm'
import { bootstrapAgents } from '../core/bootstrap.js'
import { createSpawnAgentCreator } from '../runtime/subagent-in-process-creator.js'
import { createTestAgent, EchoLlmAdapter, withAgentLoop } from './agent-loop-fixtures.js'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@fly-novel/tools'

class ParentAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.requests.length === 1) {
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'delegate-1' as ToolCallId, name: 'delegate', arguments: JSON.stringify({ task: '  分析任务  ' }) } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '父 Agent 已收到结果' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

test('父 Agent 通过正式委派工具运行通用子 Agent 并接收结果', async () => {
  const framework = await bootstrapAgents()
  const parentAdapter = new ParentAdapter()
  const childAdapter = new EchoLlmAdapter()
  const create = createSpawnAgentCreator(framework, { 'generic-subagent': {
    'agent-loop-runtime': { provider: 'child', model: 'child-model' },
    llm: { adapters: [{ providers: ['child'], adapter: childAdapter }] },
  } })
  framework.presets.register({ id: 'delegate-parent', version: '1', role: 'general', plugins: withAgentLoop([
    { pluginId: 'tools' }, { pluginId: 'subagent' }, { pluginId: 'subagent-spawn-in-process' }, { pluginId: 'tool-subagent' },
  ]) })
  try {
    const parent = await createTestAgent(framework, { id: 'parent', presetId: 'delegate-parent', pluginConfigs: {
      'agent-loop-runtime': { provider: 'parent', model: 'parent-model', workingDirectory: process.cwd() },
      llm: { adapters: [{ providers: ['parent'], adapter: parentAdapter }] },
      'subagent-spawn-in-process': { create },
    } })
    assert.deepEqual(await parent.run({ prompt: '请委派任务' }), { content: '父 Agent 已收到结果' })
    assert.ok(parentAdapter.requests[0]?.tools?.some(tool => tool.name === 'delegate'))
    const result = parentAdapter.requests[1]?.messages.at(-1)?.content[0]
    assert.ok(result?.type === 'tool-result')
    assert.equal(result.isError, false)
    assert.deepEqual(result.content, [{ type: 'text', text: '  分析任务  ' }])
    assert.deepEqual(framework.manager.list().map(agent => agent.info.identity.id), ['parent'])
    const schemas = parent.context.tools.schemas()
    assert.deepEqual(schemas.map(item => item.name), ['delegate'])
  } finally { await framework.manager.disposeAll() }
})

test('可信装配可为委派工具选择专用子 Agent Preset', async () => {
  const framework = await bootstrapAgents()
  framework.presets.register({ ...framework.presets.get('generic-subagent'), id: 'restricted-child' })
  const parentAdapter = new ParentAdapter()
  const create = createSpawnAgentCreator(framework, { 'restricted-child': {
    'agent-loop-runtime': { provider: 'child', model: 'child-model' },
    llm: { adapters: [{ providers: ['child'], adapter: new EchoLlmAdapter() }] },
  } })
  framework.presets.register({ id: 'configured-parent', version: '1', role: 'general', plugins: withAgentLoop([
    { pluginId: 'tools' }, { pluginId: 'subagent' }, { pluginId: 'subagent-spawn-in-process' }, { pluginId: 'tool-subagent' },
  ]) })
  try {
    const parent = await createTestAgent(framework, { id: 'configured-parent', presetId: 'configured-parent', pluginConfigs: {
      'agent-loop-runtime': { provider: 'parent', model: 'model', workingDirectory: process.cwd() },
      llm: { adapters: [{ providers: ['parent'], adapter: parentAdapter }] },
      'subagent-spawn-in-process': { create }, 'tool-subagent': { presetId: 'restricted-child' },
    } })
    assert.deepEqual(await parent.run({ prompt: '委派' }), { content: '父 Agent 已收到结果' })
    assert.deepEqual(framework.manager.list().map(agent => agent.info.identity.id), ['configured-parent'])
  } finally { await framework.manager.disposeAll() }
})

test('通用委派工具拒绝空任务，并按 Agent 作用域隔离', async () => {
  const framework = await bootstrapAgents()
  const create = createSpawnAgentCreator(framework, { 'generic-subagent': {
    'agent-loop-runtime': { provider: 'child', model: 'model' }, llm: { adapters: [{ providers: ['child'], adapter: new EchoLlmAdapter() }] },
  } })
  framework.presets.register({ id: 'delegate-parent', version: '1', role: 'general', plugins: withAgentLoop([
    { pluginId: 'tools' }, { pluginId: 'subagent' }, { pluginId: 'subagent-spawn-in-process' }, { pluginId: 'tool-subagent' },
  ]) })
  try {
    const configs = { 'subagent-spawn-in-process': { create } }
    const first = await createTestAgent(framework, { id: 'first', presetId: 'delegate-parent', pluginConfigs: configs })
    const second = await createTestAgent(framework, { id: 'second', presetId: 'delegate-parent', pluginConfigs: configs })
    const response = await first.context.tools.execute({ calls: [{ type: 'tool-call', id: 'empty' as ToolCallId, name: 'delegate', arguments: '{"task":"  "}' }], signal: new AbortController().signal, workingDirectory: process.cwd() })
    const result = response.results[0]!.result
    assert.equal(result.isError, true)
    if (result.isError) assert.match(result.error.message, /不能为空/)
    assert.equal(framework.manager.list().length, 2)
    await framework.manager.dispose('first')
    assert.ok(second.context.tools.get('delegate'))
  } finally { await framework.manager.disposeAll() }
})

test('没有 spawn Provider 时拒绝装配通用委派工具', async () => {
  const framework = await bootstrapAgents()
  framework.presets.register({ id: 'missing-provider', version: '1', role: 'general', plugins: withAgentLoop([
    { pluginId: 'tools' }, { pluginId: 'subagent' }, { pluginId: 'tool-subagent' },
  ]) })
  try {
    await assert.rejects(createTestAgent(framework, { id: 'parent', presetId: 'missing-provider' }), /spawn Provider/)
    assert.deepEqual(framework.manager.list(), [])
  } finally { await framework.manager.disposeAll() }
})

test('同一 Agent 中委派工具名称冲突时拒绝初始化', async () => {
  const framework = await bootstrapAgents()
  const duplicate = Object.assign((ctx: Context) => {
    ctx.effect(() => ctx.tools.register(defineTool({ name: 'delegate', description: '重复工具', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() { return '重复' },
    })))
  }, { inject: ['tools'] })
  framework.plugins.register({ id: 'duplicate-delegate', version: '1', plugin: duplicate })
  framework.presets.register({ id: 'duplicate-parent', version: '1', role: 'general', plugins: withAgentLoop([
    { pluginId: 'tools' }, { pluginId: 'subagent' }, { pluginId: 'subagent-spawn-in-process' }, { pluginId: 'duplicate-delegate' }, { pluginId: 'tool-subagent' },
  ]) })
  const create = createSpawnAgentCreator(framework, {})
  try {
    await assert.rejects(createTestAgent(framework, { id: 'parent', presetId: 'duplicate-parent', pluginConfigs: { 'subagent-spawn-in-process': { create } } }), /已注册/)
    assert.deepEqual(framework.manager.list(), [])
  } finally { await framework.manager.disposeAll() }
})

test('模型错误作为工具失败返回并释放子 Agent', async () => {
  class FailingAdapter extends LlmAdapter {
    override async *stream(): AsyncIterable<StreamChunk> {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: '模拟模型失败', code: 'PROVIDER_ERROR' } } }
    }
  }
  const framework = await bootstrapAgents()
  const create = createSpawnAgentCreator(framework, { 'generic-subagent': {
    'agent-loop-runtime': { provider: 'child', model: 'model' }, llm: { adapters: [{ providers: ['child'], adapter: new FailingAdapter() }] },
  } })
  framework.presets.register({ id: 'delegate-parent', version: '1', role: 'general', plugins: withAgentLoop([
    { pluginId: 'tools' }, { pluginId: 'subagent' }, { pluginId: 'subagent-spawn-in-process' }, { pluginId: 'tool-subagent' },
  ]) })
  try {
    const parent = await createTestAgent(framework, { id: 'parent', presetId: 'delegate-parent', pluginConfigs: { 'subagent-spawn-in-process': { create } } })
    const response = await parent.context.tools.execute({ calls: [{ type: 'tool-call', id: 'fail' as ToolCallId, name: 'delegate', arguments: '{"task":"任务"}' }], signal: new AbortController().signal, workingDirectory: process.cwd() })
    const result = response.results[0]!.result
    assert.equal(result.isError, true)
    if (result.isError) assert.match(result.error.message, /子任务执行失败.*PROVIDER_ERROR/)
    assert.deepEqual(framework.manager.list().map(agent => agent.info.identity.id), ['parent'])
  } finally { await framework.manager.disposeAll() }
})

test('工具调用取消传递给正在执行的子 Agent 并释放实例', { timeout: 3000 }, async () => {
  let enter!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  class WaitingAdapter extends LlmAdapter {
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      const signal = options.signal
      if (!signal) throw new Error('测试缺少取消信号')
      enter()
      if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      yield { type: 'finish', reason: { kind: 'aborted', failure: { message: '取消', code: 'ABORTED' } } }
    }
  }
  const framework = await bootstrapAgents()
  const create = createSpawnAgentCreator(framework, { 'generic-subagent': {
    'agent-loop-runtime': { provider: 'child', model: 'model' }, llm: { adapters: [{ providers: ['child'], adapter: new WaitingAdapter() }] },
  } })
  framework.presets.register({ id: 'delegate-parent', version: '1', role: 'general', plugins: withAgentLoop([
    { pluginId: 'tools' }, { pluginId: 'subagent' }, { pluginId: 'subagent-spawn-in-process' }, { pluginId: 'tool-subagent' },
  ]) })
  try {
    const parent = await createTestAgent(framework, { id: 'parent', presetId: 'delegate-parent', pluginConfigs: { 'subagent-spawn-in-process': { create } } })
    const controller = new AbortController()
    const executing = parent.context.tools.execute({ calls: [{ type: 'tool-call', id: 'cancel' as ToolCallId, name: 'delegate', arguments: '{"task":"任务"}' }], signal: controller.signal, workingDirectory: process.cwd() })
    await entered
    controller.abort()
    const result = (await executing).results[0]!.result
    assert.equal(result.isError, true)
    if (result.isError) assert.equal(result.error.info.code, 'ABORTED')
    assert.deepEqual(framework.manager.list().map(agent => agent.info.identity.id), ['parent'])
  } finally { await framework.manager.disposeAll() }
})
