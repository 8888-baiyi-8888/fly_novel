import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@fly-novel/llm'
import { subagentRunId, type SubagentProvider, type SubagentStartRequest } from '@fly-novel/subagent'
import { startInProcessRun } from '@fly-novel/subagent-in-process-driver'
import { bootstrapAgents } from '../core/bootstrap.js'
import { createTestAgent, EchoLlmAdapter, withAgentLoop } from './agent-loop-fixtures.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

class FailingAdapter extends LlmAdapter {
  override async *stream(): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'error', failure: { message: '测试失败', code: 'PROVIDER_ERROR' } } }
  }
}

class WaitingAdapter extends LlmAdapter {
  readonly entered = deferred<void>()
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (!options.signal) throw new Error('测试需要取消信号')
    this.entered.resolve()
    const signal = options.signal
    if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    yield { type: 'finish', reason: { kind: 'aborted', failure: { message: '请求已取消', code: 'ABORTED' } } }
  }
}

async function setup(adapter: LlmAdapter, childPreset = 'character-agent') {
  const framework = await bootstrapAgents()
  const childId = 'integration-child'
  let unregister!: () => void
  let startedSignal!: AbortSignal
  const providerPlugin = Object.assign((ctx: Context) => {
    const provider: SubagentProvider = { name: 'test-provider', start(request) {
      startedSignal = request.signal
      return startInProcessRun(request, async () => {
        const child = await createTestAgent(framework, {
          id: childId, presetId: childPreset,
          pluginConfigs: { llm: { adapters: [{ providers: ['test-provider'], adapter }] } },
        })
        return { id: subagentRunId('test-run'), agent: child, dispose: () => framework.manager.dispose(childId) }
      })
    } }
    ctx.effect(() => { unregister = ctx.subagents.registerProvider(provider); return unregister })
  }, { inject: ['subagents'] })
  framework.plugins.register({ id: 'integration-provider', version: '1', plugin: providerPlugin })
  framework.presets.register({ id: 'integration-parent', version: '1', role: 'character', plugins: withAgentLoop([
    { pluginId: 'subagent' }, { pluginId: 'integration-provider' },
  ]) })
  const parent = await createTestAgent(framework, { id: 'integration-parent', presetId: 'integration-parent' })
  const service = parent.context.get('subagents')
  assert.ok(service)
  const request = (signal = new AbortController().signal): SubagentStartRequest => ({ parent, prompt: '原始任务：检查设定', signal })
  return { framework, parent, service, request, childId, unregister: () => unregister(), startedSignal: () => startedSignal }
}

test('真实 Factory 与 Manager 完成模拟委派、结果交付和移除', async () => {
  const env = await setup(new EchoLlmAdapter())
  try {
    const run = await env.service.start('test-provider', env.request())
    const child = env.framework.manager.get(env.childId)
    assert.notEqual(child, env.parent)
    env.unregister()
    assert.equal(env.service.getProvider('test-provider'), undefined)
    assert.deepEqual(await run.result, { output: '原始任务：检查设定', stopReason: 'completed' })
    await run.dispose()
    assert.equal(child.state, 'disposed')
    assert.throws(() => env.framework.manager.get(env.childId), /不存在/)
  } finally {
    await env.framework.manager.disposeAll()
  }
})

test('真实 Agent Loop 的模型错误经 Driver 返回并在释放后移除 Agent', async () => {
  const env = await setup(new FailingAdapter())
  try {
    const run = await env.service.start('test-provider', env.request())
    assert.deepEqual(await run.result, { output: '', stopReason: 'error', errorCode: 'PROVIDER_ERROR' })
    await run.dispose()
    assert.throws(() => env.framework.manager.get(env.childId), /不存在/)
  } finally {
    await env.framework.manager.disposeAll()
  }
})

test('取消真实 Agent Loop 的运行并释放 Manager 中的子 Agent', { timeout: 3000 }, async () => {
  const adapter = new WaitingAdapter()
  const env = await setup(adapter)
  try {
    const controller = new AbortController()
    const run = await env.service.start('test-provider', env.request(controller.signal))
    await adapter.entered.promise
    controller.abort()
    assert.deepEqual(await run.result, { output: '', stopReason: 'aborted' })
    await run.dispose()
    assert.throws(() => env.framework.manager.get(env.childId), /不存在/)
  } finally {
    await env.framework.manager.disposeAll()
  }
})

test('创建失败不在 Manager 中留下子 Agent', async () => {
  const env = await setup(new EchoLlmAdapter(), 'missing-child-preset')
  try {
    await assert.rejects(env.service.start('test-provider', env.request()), /Preset/)
    assert.throws(() => env.framework.manager.get(env.childId), /不存在/)
  } finally {
    await env.framework.manager.disposeAll()
  }
})

test('父 Agent 关闭时等待真实 Manager 的延迟创建并回滚子 Agent', { timeout: 3000 }, async () => {
  const env = await setup(new EchoLlmAdapter(), 'integration-delayed-child')
  const gate = deferred<void>()
  const entered = deferred<void>()
  env.framework.plugins.register({ id: 'integration-delay', version: '1', plugin: async () => { entered.resolve(); await gate.promise } })
  env.framework.presets.register({ id: 'integration-delayed-child', version: '1', role: 'character', plugins: withAgentLoop([{ pluginId: 'integration-delay' }]) })
  try {
    const starting = env.service.start('test-provider', env.request())
    const rejected = assert.rejects(starting, /服务已关闭/)
    await entered.promise
    const closing = env.framework.manager.dispose('integration-parent')
    const signal = env.startedSignal()
    if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    let closed = false
    void closing.then(() => { closed = true })
    await Promise.resolve()
    assert.equal(closed, false)
    gate.resolve()
    await rejected
    await closing
    assert.throws(() => env.framework.manager.get(env.childId), /不存在/)
  } finally {
    gate.resolve()
    await env.framework.manager.disposeAll()
  }
})
