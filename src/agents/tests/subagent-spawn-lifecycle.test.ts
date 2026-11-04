import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@fly-novel/llm'
import { SubagentStartupCleanupError, type SubagentStartRequest } from '@fly-novel/subagent'
import { bootstrapAgents } from '../core/bootstrap.js'
import { createSpawnAgentCreator } from '../runtime/subagent-in-process-creator.js'
import { createTestAgent, EchoLlmAdapter, withAgentLoop } from './agent-loop-fixtures.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

class WaitingAdapter extends LlmAdapter {
  readonly entered = deferred<void>()
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const signal = options.signal
    if (!signal) throw new Error('测试需要取消信号')
    this.entered.resolve()
    if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    yield { type: 'finish', reason: { kind: 'aborted', failure: { message: '请求已取消', code: 'ABORTED' } } }
  }
}

async function setup(adapter: LlmAdapter, delayed = false) {
  const framework = await bootstrapAgents()
  const gate = deferred<void>()
  const entered = deferred<void>()
  if (delayed) framework.plugins.register({ id: 'spawn-delay', version: '1', plugin: async () => { entered.resolve(); await gate.promise } })
  framework.presets.register({ id: 'lifecycle-child', version: '1', role: 'character', plugins: withAgentLoop([
    ...(delayed ? [{ pluginId: 'spawn-delay' }] : []),
  ]) })
  const creator = createSpawnAgentCreator(framework, { 'lifecycle-child': {
    'agent-loop-runtime': { provider: 'child', model: 'model' },
    llm: { adapters: [{ providers: ['child'], adapter }] },
  } })
  let receivedSignal: AbortSignal | undefined
  const create: typeof creator = request => { receivedSignal = request.signal; return creator(request) }
  framework.presets.register({ id: 'lifecycle-parent', version: '1', role: 'character', plugins: withAgentLoop([
    { pluginId: 'subagent' }, { pluginId: 'subagent-spawn-in-process' },
  ]) })
  const parent = await createTestAgent(framework, { id: 'parent', presetId: 'lifecycle-parent', pluginConfigs: { 'subagent-spawn-in-process': { create } } })
  const request = (signal = new AbortController().signal): SubagentStartRequest => ({ parent, presetId: 'lifecycle-child', prompt: '任务', signal })
  return { framework, parent, gate, entered, request, signal: () => receivedSignal }
}

test('创建前取消不会创建子 Agent', async () => {
  const env = await setup(new EchoLlmAdapter())
  try {
    const controller = new AbortController()
    controller.abort(new Error('提前取消'))
    await assert.rejects(env.parent.context.subagents.start('spawn', env.request(controller.signal)), /提前取消/)
    assert.equal(env.signal(), undefined)
    assert.deepEqual(env.framework.manager.list().map(a => a.info.identity.id), ['parent'])
  } finally { await env.framework.manager.disposeAll() }
})

test('创建期间取消等待初始化结束并回滚迟到的 Agent', { timeout: 3000 }, async () => {
  const env = await setup(new EchoLlmAdapter(), true)
  try {
    const controller = new AbortController()
    const starting = env.parent.context.subagents.start('spawn', env.request(controller.signal))
    const rejected = assert.rejects(starting, /创建取消/)
    await env.entered.promise
    controller.abort(new Error('创建取消'))
    let settled = false
    void starting.then(() => { settled = true }, () => { settled = true })
    await Promise.resolve()
    assert.equal(settled, false)
    env.gate.resolve()
    await rejected
    assert.deepEqual(env.framework.manager.list().map(a => a.info.identity.id), ['parent'])
  } finally { env.gate.resolve(); await env.framework.manager.disposeAll() }
})

test('并发任务中仅取消目标运行，完成后可重复并发释放', { timeout: 3000 }, async () => {
  const adapter = new WaitingAdapter()
  const env = await setup(adapter)
  try {
    const controller = new AbortController()
    const first = await env.parent.context.subagents.start('spawn', env.request(controller.signal))
    await adapter.entered.promise
    const second = await env.parent.context.subagents.start('spawn', env.request())
    assert.notEqual(first.id, second.id)
    controller.abort()
    assert.deepEqual(await first.result, { output: '', stopReason: 'aborted' })
    assert.equal(env.framework.manager.list().length, 3)
    await Promise.all([first.dispose(), first.dispose()])
    assert.equal(env.framework.manager.list().length, 2)
    await Promise.all([second.dispose(), second.dispose()])
    assert.deepEqual(await second.result, { output: '', stopReason: 'aborted' })
    assert.deepEqual(env.framework.manager.list().map(a => a.info.identity.id), ['parent'])
  } finally { await env.framework.manager.disposeAll() }
})

test('任务完成后取消不改变结果，并发释放移除子 Agent', async () => {
  const env = await setup(new EchoLlmAdapter())
  try {
    const controller = new AbortController()
    const run = await env.parent.context.subagents.start('spawn', env.request(controller.signal))
    assert.deepEqual(await run.result, { output: '任务', stopReason: 'completed' })
    controller.abort()
    assert.deepEqual(await run.result, { output: '任务', stopReason: 'completed' })
    await Promise.all([run.dispose(), run.dispose()])
    assert.deepEqual(env.framework.manager.list().map(a => a.info.identity.id), ['parent'])
  } finally { await env.framework.manager.disposeAll() }
})

test('父 Agent 关闭后已交付运行仍由调用方取消和释放', { timeout: 3000 }, async () => {
  const adapter = new WaitingAdapter()
  const env = await setup(adapter)
  try {
    const controller = new AbortController()
    const run = await env.parent.context.subagents.start('spawn', env.request(controller.signal))
    await adapter.entered.promise
    await env.framework.manager.dispose('parent')
    assert.equal(env.framework.manager.list().length, 1)
    controller.abort()
    assert.deepEqual(await run.result, { output: '', stopReason: 'aborted' })
    await run.dispose()
    assert.deepEqual(env.framework.manager.list(), [])
  } finally { await env.framework.manager.disposeAll() }
})

test('父 Agent 关闭等待未交付创建，且与 disposeAll 交错不死锁', { timeout: 3000 }, async () => {
  const env = await setup(new EchoLlmAdapter(), true)
  try {
    const starting = env.parent.context.subagents.start('spawn', env.request())
    const rejected = assert.rejects(starting, /服务已关闭/)
    await env.entered.promise
    const closing = env.framework.manager.dispose('parent')
    const signal = env.signal()!
    if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    const all = env.framework.manager.disposeAll()
    env.gate.resolve()
    await Promise.all([rejected, closing, all])
    assert.deepEqual(env.framework.manager.list(), [])
  } finally { env.gate.resolve(); await env.framework.manager.disposeAll() }
})

test('关闭时创建回滚失败会同时通知启动和关闭方', { timeout: 3000 }, async t => {
  const env = await setup(new EchoLlmAdapter(), true)
  const originalDispose = env.framework.manager.dispose.bind(env.framework.manager)
  t.mock.method(env.framework.manager, 'dispose', async (id: string) => {
    await originalDispose(id)
    if (id !== 'parent') throw new Error('模拟清理失败')
  })
  try {
    const starting = env.parent.context.subagents.start('spawn', env.request())
    const startRejected = assert.rejects(starting, error => {
      assert.ok(error instanceof SubagentStartupCleanupError)
      assert.match(String(error.errors[0]), /服务已关闭/)
      assert.match(String(error.errors[1]), /模拟清理失败/)
      return true
    })
    await env.entered.promise
    const closing = env.framework.manager.dispose('parent')
    const closeRejected = assert.rejects(closing)
    const signal = env.signal()!
    if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    env.gate.resolve()
    await Promise.all([startRejected, closeRejected])
    assert.deepEqual(env.framework.manager.list(), [])
  } finally { env.gate.resolve(); t.mock.restoreAll(); await env.framework.manager.disposeAll() }
})
