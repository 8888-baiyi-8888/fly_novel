import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SubagentRuntime, subagentRunId, type SubagentProvider, type SubagentResult, type SubagentRun } from '@fly-novel/subagent'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

const request = () => ({ parent: { info: { identity: { id: 'parent' } } }, prompt: '分析设定', signal: new AbortController().signal })

test('启动路由返回运行句柄而不等待结果，注销不影响已交付运行', async () => {
  const service = new SubagentRuntime()
  const result = deferred<SubagentResult>()
  const input = request()
  let received = false
  let disposed = false
  const provider: SubagentProvider = { name: 'mock', async start(value) {
    assert.equal(value.parent, input.parent)
    assert.equal(value.prompt, input.prompt)
    received = true
    return { id: subagentRunId('one'), result: result.promise, async dispose() { disposed = true } }
  } }
  const unregister = service.registerProvider(provider)
  await assert.rejects(service.start('missing', input), /未注册/)
  const run = await service.start('mock', input)
  assert.equal(received, true)
  unregister()
  await service.dispose()
  assert.equal(disposed, false)
  result.resolve({ output: '结果', stopReason: 'completed' })
  assert.deepEqual(await run.result, { output: '结果', stopReason: 'completed' })
  await run.dispose()
  assert.equal(disposed, true)
})

test('启动失败、任务失败与基础设施失败分别传播', async () => {
  const service = new SubagentRuntime()
  service.registerProvider({ name: 'bad', async start() { throw new Error('启动失败') } })
  await assert.rejects(service.start('bad', request()), /启动失败/)
  service.registerProvider({ name: 'task', async start() { return {
    id: subagentRunId('task'), result: Promise.resolve({ output: '', stopReason: 'error' }), async dispose() {},
  } } })
  const run = await service.start('task', request())
  assert.equal((await run.result).stopReason, 'error')
  await run.dispose()
  service.registerProvider({ name: 'fault', async start() { return {
    id: subagentRunId('fault'), result: Promise.reject(new Error('基础设施故障')), async dispose() {},
  } } })
  const failed = await service.start('fault', request())
  await assert.rejects(failed.result, /基础设施故障/)
  await failed.dispose()
  await service.dispose()
})

test('关闭期间等待未交付的启动并释放迟到的句柄', async () => {
  const service = new SubagentRuntime()
  const gate = deferred<SubagentRun>()
  let signal!: AbortSignal
  let disposals = 0
  service.registerProvider({ name: 'slow', start(value) { signal = value.signal; return gate.promise } })
  const starting = service.start('slow', request())
  const rejected = assert.rejects(starting, /服务已关闭/)
  const closing = service.dispose()
  assert.equal(service.dispose(), closing)
  assert.equal(signal.aborted, true)
  let closed = false
  void closing.then(() => { closed = true })
  await Promise.resolve()
  assert.equal(closed, false)
  gate.resolve({ id: subagentRunId('late'), result: Promise.reject(new Error('失败')), async dispose() { disposals++ } })
  await rejected
  await closing
  assert.equal(disposals, 1)
  await assert.rejects(service.start('slow', request()), /已关闭/)
})

test('请求取消与并发运行相互独立', async () => {
  const service = new SubagentRuntime()
  const controller = new AbortController()
  const pending = deferred<SubagentRun>()
  let signal!: AbortSignal
  service.registerProvider({ name: 'mock', start(value) {
    if (value.prompt === 'slow') { signal = value.signal; return pending.promise }
    return Promise.resolve({ id: subagentRunId('other'), result: Promise.resolve({ output: 'ok', stopReason: 'completed' }), async dispose() {} })
  } })
  const slow = service.start('mock', { ...request(), prompt: 'slow', signal: controller.signal })
  const rejected = assert.rejects(slow, /取消任务/)
  const other = await service.start('mock', request())
  controller.abort(new Error('取消任务'))
  assert.equal(signal.aborted, true)
  let disposed = false
  pending.resolve({ id: subagentRunId('slow'), result: Promise.resolve({ output: '', stopReason: 'aborted' }), async dispose() { disposed = true } })
  await rejected
  assert.equal(disposed, true)
  assert.equal((await other.result).output, 'ok')
  await other.dispose()
  await service.dispose()
})

test('已取消的请求不启动 Provider，交付后取消信号仍传递给运行', async () => {
  const service = new SubagentRuntime()
  let calls = 0
  let childSignal!: AbortSignal
  service.registerProvider({ name: 'mock', async start(value) {
    calls++
    childSignal = value.signal
    return { id: subagentRunId('one'), result: Promise.resolve({ output: '', stopReason: 'completed' }), async dispose() {} }
  } })
  const cancelled = new AbortController()
  cancelled.abort(new Error('提前取消'))
  await assert.rejects(service.start('mock', { ...request(), signal: cancelled.signal }), /提前取消/)
  assert.equal(calls, 0)
  const active = new AbortController()
  const run = await service.start('mock', { ...request(), signal: active.signal })
  await service.dispose()
  assert.equal(childSignal.aborted, false)
  active.abort(new Error('后续取消'))
  assert.equal(childSignal.aborted, true)
  await run.dispose()
})

test('迟到句柄的释放失败同时报告给启动和关闭调用方', async () => {
  const service = new SubagentRuntime()
  const gate = deferred<SubagentRun>()
  service.registerProvider({ name: 'slow', start() { return gate.promise } })
  const starting = service.start('slow', request())
  const rejected = assert.rejects(starting, /启动取消且清理失败/)
  const closing = service.dispose()
  const closeRejected = assert.rejects(closing, /启动清理失败/)
  gate.resolve({ id: subagentRunId('late'), result: Promise.resolve({ output: '', stopReason: 'aborted' }), async dispose() { throw new Error('释放失败') } })
  await rejected
  await closeRejected
})
