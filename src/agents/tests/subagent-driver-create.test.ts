import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SubagentRuntime, SubagentStartupCleanupError, subagentRunId, type SubagentStartRequest } from '@fly-novel/subagent'
import { createInProcessAgent, type InProcessAgentHandle } from '@fly-novel/subagent-in-process-driver'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

const request = (signal: AbortSignal): SubagentStartRequest => ({ parent: { info: { identity: { id: 'parent' } } }, prompt: '任务原文', signal })
const handle = (dispose: () => Promise<void>): InProcessAgentHandle => ({
  id: subagentRunId('run'), agent: { async run(input) { return { content: input.prompt } }, cancel() {} }, dispose,
})

test('创建前取消不调用创建方，创建成功交付原句柄且不执行任务', async () => {
  const cancelled = new AbortController()
  cancelled.abort(new Error('提前取消'))
  let calls = 0
  await assert.rejects(createInProcessAgent(request(cancelled.signal), async () => { calls++; return handle(async () => {}) }), /提前取消/)
  assert.equal(calls, 0)
  let runs = 0
  const created: InProcessAgentHandle = {
    ...handle(async () => {}),
    agent: { async run() { runs++; return { content: '' } }, cancel() {} },
  }
  const input = request(new AbortController().signal)
  const result = await createInProcessAgent(input, async actual => { calls++; assert.equal(actual, input); return created })
  assert.equal(result, created)
  assert.equal(calls, 1)
  assert.equal(runs, 0)
  await result.dispose()
})

test('创建失败原样传播，由创建方处理未交付资源', async () => {
  const failure = new Error('创建失败')
  await assert.rejects(createInProcessAgent(request(new AbortController().signal), async () => { throw failure }), error => error === failure)
})

test('创建中取消等待迟到句柄和异步回滚，再拒绝启动', async () => {
  const creation = deferred<InProcessAgentHandle>()
  const cleanup = deferred<void>()
  const controller = new AbortController()
  let disposed = 0
  const starting = createInProcessAgent(request(controller.signal), () => creation.promise)
  const rejected = assert.rejects(starting, /取消启动/)
  controller.abort(new Error('取消启动'))
  creation.resolve(handle(async () => { disposed++; await cleanup.promise }))
  await Promise.resolve()
  assert.equal(disposed, 1)
  let settled = false
  void rejected.then(() => { settled = true })
  await Promise.resolve()
  assert.equal(settled, false)
  cleanup.resolve()
  await rejected
  assert.equal(disposed, 1)
})

test('服务关闭期间 Driver 回滚失败同时报告启动和关闭调用方', async () => {
  const service = new SubagentRuntime()
  const creation = deferred<InProcessAgentHandle>()
  const cleanupFailure = new Error('回滚失败')
  service.registerProvider({ name: 'mock', async start(input) {
    const child = await createInProcessAgent(input, () => creation.promise)
    return { id: child.id, result: Promise.resolve({ output: '', stopReason: 'completed' }), dispose: () => child.dispose() }
  } })
  const starting = service.start('mock', request(new AbortController().signal))
  const startRejected = assert.rejects(starting, error => error instanceof SubagentStartupCleanupError && error.errors[1] === cleanupFailure)
  const closing = service.dispose()
  const closeRejected = assert.rejects(closing, error => error instanceof AggregateError && error.errors.some(item => item instanceof SubagentStartupCleanupError && item.errors[1] === cleanupFailure))
  creation.resolve(handle(async () => { throw cleanupFailure }))
  await startRejected
  await closeRejected
})

test('服务关闭期间普通启动失败不伪装成回滚失败', async () => {
  const service = new SubagentRuntime()
  const gate = deferred<void>()
  service.registerProvider({ name: 'mock', async start() { await gate.promise; throw new Error('创建失败') } })
  const starting = service.start('mock', request(new AbortController().signal))
  const rejected = assert.rejects(starting, /创建失败/)
  const closing = service.dispose()
  gate.resolve()
  await rejected
  await closing
})

test('服务关闭期间创建方自行回滚失败也报告给关闭调用方', async () => {
  const service = new SubagentRuntime()
  const gate = deferred<void>()
  const cleanupFailure = new Error('创建方回滚失败')
  service.registerProvider({ name: 'mock', async start(input) {
    const child = await createInProcessAgent(input, async () => {
      await gate.promise
      throw new SubagentStartupCleanupError(input.signal.reason, cleanupFailure)
    })
    return { id: child.id, result: Promise.resolve({ output: '', stopReason: 'completed' }), dispose: () => child.dispose() }
  } })
  const starting = service.start('mock', request(new AbortController().signal))
  const rejected = assert.rejects(starting, error => error instanceof SubagentStartupCleanupError && error.errors[1] === cleanupFailure)
  const closing = service.dispose()
  const closeRejected = assert.rejects(closing, error => error instanceof AggregateError && error.errors.some(item => item instanceof SubagentStartupCleanupError && item.errors[1] === cleanupFailure))
  gate.resolve()
  await rejected
  await closeRejected
})
