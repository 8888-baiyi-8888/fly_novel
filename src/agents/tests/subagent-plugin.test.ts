import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { SubagentRuntime, subagentRunId, type SubagentProvider, type SubagentResult, type SubagentRun } from '@fly-novel/subagent'
import { bootstrapAgents } from '../core/bootstrap.js'
import { createTestAgent, withAgentLoop } from './agent-loop-fixtures.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

test('未装配 Subagent 插件的 Agent 销毁时不关闭继承的根服务', async () => {
  const framework = await bootstrapAgents()
  const rootService = new SubagentRuntime()
  const rootScope = framework.context.plugin(ctx => { ctx.provide('subagents', rootService) })
  await rootScope
  try {
    const agent = await createTestAgent(framework, { id: 'inherited-root', presetId: 'character-agent' })
    assert.equal(agent.context.get('subagents'), rootService)
    await framework.manager.dispose('inherited-root')
    assert.deepEqual(rootService.list(), [])
  } finally {
    await framework.manager.disposeAll()
    await rootService.dispose()
    await rootScope.dispose()
  }
})

test('Agent 的 Subagent 插件和 Provider 共享作用域，各实例独立', async () => {
  const framework = await bootstrapAgents()
  const result = deferred<SubagentResult>()
  let releaseCount = 0
  let received = ''
  const provider: SubagentProvider = { name: 'mock', async start(request) {
    received = request.prompt
    return { id: subagentRunId('run-1'), result: result.promise, async dispose() { releaseCount++ } }
  } }
  const providerPlugin = Object.assign((ctx: Context) => {
    ctx.effect(() => ctx.subagents.registerProvider(provider))
  }, { inject: ['subagents'] })
  framework.plugins.register({ id: 'subagent-mock', version: '1', plugin: providerPlugin })
  framework.presets.register({ id: 'subagent-test', version: '1', role: 'character', plugins: withAgentLoop([
    { pluginId: 'subagent-mock' }, { pluginId: 'subagent' },
  ]) })
  try {
    assert.ok(framework.plugins.get('subagent'))
    const first = await createTestAgent(framework, { id: 'subagent-a', presetId: 'subagent-test' })
    const second = await createTestAgent(framework, { id: 'subagent-b', presetId: 'subagent-test' })
    const service = first.context.get('subagents')
    const other = second.context.get('subagents')
    assert.ok(service)
    assert.ok(other)
    assert.notEqual(service, other)
    assert.equal(framework.context.get('subagents'), undefined)
    assert.equal(service.getProvider('mock'), provider)
    assert.equal(other.getProvider('mock'), provider)
    const unregisterFailure = service.registerProvider({ name: 'failed', async start() { throw new Error('模拟启动失败') } })
    await assert.rejects(service.start('failed', { parent: first, prompt: '任务', signal: new AbortController().signal }), /模拟启动失败/)
    unregisterFailure()
    const run = await service.start('mock', { parent: first, prompt: '独立分析', signal: new AbortController().signal })
    assert.equal(received, '独立分析')
    result.resolve({ output: '分析结果', stopReason: 'completed' })
    assert.deepEqual(await run.result, { output: '分析结果', stopReason: 'completed' })
    await framework.manager.dispose('subagent-a')
    assert.equal(first.context.get('subagents'), undefined)
    assert.throws(() => service.getProvider('mock'), /已关闭/)
    assert.equal(other.getProvider('mock'), provider)
    assert.equal(releaseCount, 0)
    await run.dispose()
    assert.equal(releaseCount, 1)
  } finally {
    await framework.manager.disposeAll()
  }
})

test('销毁 Agent 等待尚未交付的启动和迟到句柄的清理', async () => {
  const framework = await bootstrapAgents()
  const gate = deferred<SubagentRun>()
  let signal!: AbortSignal
  let released = false
  const providerPlugin = Object.assign((ctx: Context) => {
    const provider: SubagentProvider = { name: 'slow', start(request) { signal = request.signal; return gate.promise } }
    ctx.effect(() => ctx.subagents.registerProvider(provider))
  }, { inject: ['subagents'] })
  framework.plugins.register({ id: 'subagent-slow', version: '1', plugin: providerPlugin })
  framework.presets.register({ id: 'subagent-slow-test', version: '1', role: 'character', plugins: withAgentLoop([
    { pluginId: 'subagent' }, { pluginId: 'subagent-slow' },
  ]) })
  try {
    const agent = await createTestAgent(framework, { id: 'subagent-slow', presetId: 'subagent-slow-test' })
    const service = agent.context.get('subagents')
    assert.ok(service)
    const starting = service.start('slow', { parent: agent, prompt: '任务', signal: new AbortController().signal })
    const startRejected = assert.rejects(starting, /服务已关闭/)
    const disposing = framework.manager.dispose('subagent-slow')
    let finished = false
    void disposing.then(() => { finished = true })
    // 等待 Agent Loop 退出，直到 Cordis 开始释放 Subagent 服务。
    if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    assert.equal(finished, false)
    gate.resolve({ id: subagentRunId('late'), result: Promise.resolve({ output: '', stopReason: 'aborted' }), async dispose() { released = true } })
    await startRejected
    await disposing
    assert.equal(released, true)
    assert.equal(agent.context.get('subagents'), undefined)
  } finally {
    await framework.manager.disposeAll()
  }
})

test('Agent 销毁时迟到句柄清理失败会报告给调用方', async () => {
  const framework = await bootstrapAgents()
  const gate = deferred<SubagentRun>()
  let signal!: AbortSignal
  const providerPlugin = Object.assign((ctx: Context) => {
    ctx.effect(() => ctx.subagents.registerProvider({ name: 'slow', start(request) { signal = request.signal; return gate.promise } }))
  }, { inject: ['subagents'] })
  framework.plugins.register({ id: 'subagent-failing-cleanup', version: '1', plugin: providerPlugin })
  framework.presets.register({ id: 'subagent-failing-cleanup', version: '1', role: 'character', plugins: withAgentLoop([
    { pluginId: 'subagent' }, { pluginId: 'subagent-failing-cleanup' },
  ]) })
  try {
    const agent = await createTestAgent(framework, { id: 'subagent-failing-cleanup', presetId: 'subagent-failing-cleanup' })
    const service = agent.context.get('subagents')
    assert.ok(service)
    const starting = service.start('slow', { parent: agent, prompt: '任务', signal: new AbortController().signal })
    const startRejected = assert.rejects(starting, /启动取消且清理失败/)
    const disposing = framework.manager.dispose('subagent-failing-cleanup')
    const disposeRejected = assert.rejects(disposing)
    if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    gate.resolve({ id: subagentRunId('late'), result: Promise.resolve({ output: '', stopReason: 'aborted' }), async dispose() { throw new Error('清理失败') } })
    await startRejected
    await disposeRejected
  } finally {
    await framework.manager.disposeAll()
  }
})
