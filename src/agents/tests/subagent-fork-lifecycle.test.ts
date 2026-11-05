import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@fly-novel/llm'
import { SubagentStartupCleanupError, type SubagentStartRequest } from '@fly-novel/subagent'
import { bootstrapAgents } from '../core/bootstrap.js'
import { createForkAgentCreator } from '../runtime/subagent-in-process-creator.js'
import { createTestAgent, EchoLlmAdapter, withAgentLoop } from './agent-loop-fixtures.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(accept => { resolve = accept })
  return { promise, resolve }
}

class WaitingAdapter extends LlmAdapter {
  readonly entered = deferred()
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const signal = options.signal!
    this.entered.resolve()
    if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    yield { type: 'finish', reason: { kind: 'aborted', failure: { message: '取消', code: 'ABORTED' } } }
  }
}

async function setup(adapter: LlmAdapter, delayed = false, loopExtra: Record<string, unknown> = {}, mode?: 'corrupt' | 'fault') {
  const framework = await bootstrapAgents()
  const entered = deferred()
  const gate = deferred()
  if (delayed) framework.plugins.register({ id: 'fork-delay', version: '1', plugin: async () => { entered.resolve(); await gate.promise } })
  framework.presets.register({ id: 'fork-lifecycle-child', version: '1', role: 'general', plugins: withAgentLoop(delayed ? [{ pluginId: 'fork-delay' }] : []) })
  const creator = createForkAgentCreator(framework, { 'fork-lifecycle-child': {
    'agent-loop-runtime': { provider: 'child', model: 'model', ...loopExtra }, llm: { adapters: [{ providers: ['child'], adapter }] },
  } })
  let signal: AbortSignal | undefined
  const create: typeof creator = async (request, history) => {
    signal = request.signal
    const handle = await creator(request, mode === 'corrupt' ? history.map((event, index) => ({ ...event, seq: index + 1 })) : history)
    if (mode !== 'fault') return handle
    return { ...handle, agent: { async run() { throw new Error('基础设施异常') }, cancel: () => handle.agent.cancel() } }
  }
  framework.presets.register({ id: 'fork-lifecycle-parent', version: '1', role: 'general', plugins: withAgentLoop([
    { pluginId: 'subagent' }, { pluginId: 'subagent-fork-in-process' },
  ]) })
  const parent = await createTestAgent(framework, { id: 'parent', presetId: 'fork-lifecycle-parent', pluginConfigs: { 'subagent-fork-in-process': { create } } })
  await parent.run({ prompt: '父历史' })
  const request = (signal = new AbortController().signal): SubagentStartRequest => ({ parent, presetId: 'fork-lifecycle-child', prompt: '任务', signal })
  return { framework, parent, gate, entered, request, signal: () => signal }
}

test('Fork 启动前取消与持久化配置拒绝不创建子实例或改写父历史', async () => {
  const env = await setup(new EchoLlmAdapter(), false, { sessionId: 'forbidden' })
  try {
    const session = env.parent.context.sessions.list()[0]!
    const before = session.read()
    const abort = new AbortController()
    abort.abort(new Error('提前取消'))
    await assert.rejects(env.parent.context.subagents.start('fork', env.request(abort.signal)), /提前取消/)
    assert.equal(env.signal(), undefined)
    await assert.rejects(env.parent.context.subagents.start('fork', env.request()), /持久化 Session/)
    assert.deepEqual(session.read(), before)
    assert.deepEqual(env.framework.manager.list().map(a => a.info.identity.id), ['parent'])
  } finally { await env.framework.manager.disposeAll() }
})

test('Fork 创建中取消等待迟到实例回滚，父历史保持不变', { timeout: 3000 }, async () => {
  const env = await setup(new EchoLlmAdapter(), true)
  try {
    const before = env.parent.context.sessions.list()[0]!.read()
    const abort = new AbortController()
    const starting = env.parent.context.subagents.start('fork', env.request(abort.signal))
    const rejected = assert.rejects(starting, /创建取消/)
    await env.entered.promise
    abort.abort(new Error('创建取消'))
    let settled = false
    void starting.then(() => { settled = true }, () => { settled = true })
    await Promise.resolve()
    assert.equal(settled, false)
    env.gate.resolve()
    await rejected
    assert.deepEqual(env.parent.context.sessions.list()[0]!.read(), before)
    assert.deepEqual(env.framework.manager.list().map(a => a.info.identity.id), ['parent'])
  } finally { env.gate.resolve(); await env.framework.manager.disposeAll() }
})

test('父 Session 关闭后 Fork 快照失败，不启动创建方', async () => {
  const env = await setup(new EchoLlmAdapter())
  try {
    const session = env.parent.context.sessions.list()[0]!
    await env.parent.context.sessions.close(session.id)
    await assert.rejects(env.parent.context.subagents.start('fork', env.request()), /不属于当前 Agent/)
    assert.equal(env.signal(), undefined)
    assert.deepEqual(env.framework.manager.list().map(a => a.info.identity.id), ['parent'])
  } finally { await env.framework.manager.disposeAll() }
})

test('已交付 Fork 在父 Agent 关闭后由调用方取消并重复释放', { timeout: 3000 }, async () => {
  const adapter = new WaitingAdapter()
  const env = await setup(adapter)
  try {
    const abort = new AbortController()
    const run = await env.parent.context.subagents.start('fork', env.request(abort.signal))
    await adapter.entered.promise
    await env.framework.manager.dispose('parent')
    assert.equal(env.framework.manager.list().length, 1)
    abort.abort()
    assert.deepEqual(await run.result, { output: '', stopReason: 'aborted' })
    await Promise.all([run.dispose(), run.dispose()])
    assert.deepEqual(env.framework.manager.list(), [])
  } finally { await env.framework.manager.disposeAll() }
})

test('父关闭等待未交付 Fork，和 disposeAll 并发时完成回滚', { timeout: 3000 }, async () => {
  const env = await setup(new EchoLlmAdapter(), true)
  try {
    const starting = env.parent.context.subagents.start('fork', env.request())
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

test('Fork 创建回滚失败同时告知启动方和父关闭方', { timeout: 3000 }, async t => {
  const env = await setup(new EchoLlmAdapter(), true)
  const dispose = env.framework.manager.dispose.bind(env.framework.manager)
  t.mock.method(env.framework.manager, 'dispose', async (id: string) => {
    await dispose(id)
    if (id !== 'parent') throw new Error('模拟清理失败')
  })
  try {
    const starting = env.parent.context.subagents.start('fork', env.request())
    const rejected = assert.rejects(starting, error => {
      assert.ok(error instanceof SubagentStartupCleanupError)
      assert.match(String(error.errors[0]), /服务已关闭/)
      assert.match(String(error.errors[1]), /模拟清理失败/)
      return true
    })
    await env.entered.promise
    const closing = env.framework.manager.dispose('parent')
    const closeRejected = assert.rejects(closing, /清理失败/)
    const signal = env.signal()!
    if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    env.gate.resolve()
    await Promise.all([rejected, closeRejected])
    assert.deepEqual(env.framework.manager.list(), [])
  } finally { env.gate.resolve(); t.mock.restoreAll(); await env.framework.manager.disposeAll() }
})

test('Fork 子任务错误与释放错误分别可观察', async t => {
  class FailingAdapter extends LlmAdapter {
    override async *stream(): AsyncIterable<StreamChunk> {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: '模型错误', code: 'PROVIDER_ERROR' } } }
    }
  }
  const env = await setup(new FailingAdapter())
  const dispose = env.framework.manager.dispose.bind(env.framework.manager)
  t.mock.method(env.framework.manager, 'dispose', async (id: string) => {
    await dispose(id)
    if (id !== 'parent') throw new Error('释放错误')
  })
  try {
    const before = env.parent.context.sessions.list()[0]!.read()
    const run = await env.parent.context.subagents.start('fork', env.request())
    assert.deepEqual(await run.result, { output: '', stopReason: 'error', errorCode: 'PROVIDER_ERROR' })
    await assert.rejects(run.dispose(), /释放错误/)
    assert.deepEqual(env.parent.context.sessions.list()[0]!.read(), before)
    assert.deepEqual(env.framework.manager.list().map(a => a.info.identity.id), ['parent'])
  } finally { t.mock.restoreAll(); await env.framework.manager.disposeAll() }
})

test('Fork 会话初始化失败回滚子实例，不改写父历史', async () => {
  const env = await setup(new EchoLlmAdapter(), false, {}, 'corrupt')
  try {
    const before = env.parent.context.sessions.list()[0]!.read()
    await assert.rejects(env.parent.context.subagents.start('fork', env.request()), /序号无效/)
    assert.deepEqual(env.parent.context.sessions.list()[0]!.read(), before)
    assert.deepEqual(env.framework.manager.list().map(a => a.info.identity.id), ['parent'])
  } finally { await env.framework.manager.disposeAll() }
})

test('Fork 基础设施异常和资源释放失败分别交给持有者', async t => {
  const env = await setup(new EchoLlmAdapter(), false, {}, 'fault')
  const dispose = env.framework.manager.dispose.bind(env.framework.manager)
  t.mock.method(env.framework.manager, 'dispose', async (id: string) => {
    await dispose(id)
    if (id !== 'parent') throw new Error('释放错误')
  })
  try {
    const run = await env.parent.context.subagents.start('fork', env.request())
    await assert.rejects(run.result, /基础设施异常/)
    await assert.rejects(run.dispose(), /释放错误/)
    assert.deepEqual(env.framework.manager.list().map(a => a.info.identity.id), ['parent'])
  } finally { t.mock.restoreAll(); await env.framework.manager.disposeAll() }
})
