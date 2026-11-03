import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { test } from 'node:test'
import { LlmError } from '@fly-novel/llm'
import { subagentRunId, type SubagentStartRequest } from '@fly-novel/subagent'
import { startInProcessRun } from '@fly-novel/subagent-in-process-driver'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

function request(signal: AbortSignal): SubagentStartRequest {
  return { parent: { info: { identity: { id: 'parent' } } }, prompt: '任务', signal }
}

test('并发释放共享清理，等待 Agent 释放与任务结算', async () => {
  const controller = new AbortController()
  const task = deferred<{ content: string }>()
  const cleanup = deferred<void>()
  const entered = deferred<void>()
  let cancellations = 0
  let releases = 0
  const run = await startInProcessRun(request(controller.signal), async () => ({
    id: subagentRunId('one'), agent: { run: () => task.promise, cancel() { cancellations++ } },
    async dispose() { releases++; entered.resolve(); await cleanup.promise },
  }))
  const first = run.dispose()
  assert.equal(run.dispose(), first)
  await entered.promise
  assert.equal(cancellations, 1)
  assert.equal(releases, 1)
  let finished = false
  void first.then(() => { finished = true })
  cleanup.resolve()
  await Promise.resolve()
  assert.equal(finished, false)
  task.reject(new LlmError('取消', 'ABORTED'))
  assert.deepEqual(await run.result, { output: '', stopReason: 'aborted' })
  await first
  await run.dispose()
  assert.equal(releases, 1)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

test('两个运行的取消与监听器互相独立', async () => {
  const first = new AbortController()
  const second = new AbortController()
  const firstTask = deferred<{ content: string }>()
  const secondTask = deferred<{ content: string }>()
  let secondCancelled = false
  const one = await startInProcessRun(request(first.signal), async () => ({
    id: subagentRunId('one'), agent: { run: () => firstTask.promise, cancel() { firstTask.reject(new LlmError('取消', 'ABORTED')) } }, async dispose() {},
  }))
  const two = await startInProcessRun(request(second.signal), async () => ({
    id: subagentRunId('two'), agent: { run: () => secondTask.promise, cancel() { secondCancelled = true } }, async dispose() {},
  }))
  first.abort()
  assert.equal((await one.result).stopReason, 'aborted')
  assert.equal(getEventListeners(first.signal, 'abort').length, 0)
  assert.equal(secondCancelled, false)
  secondTask.resolve({ content: '完成' })
  assert.equal((await two.result).output, '完成')
  assert.equal(getEventListeners(second.signal, 'abort').length, 0)
  await one.dispose()
  await two.dispose()
})

test('取消入口抛错仍释放 Agent，同时保留取消和清理错误', async () => {
  const controller = new AbortController()
  const task = deferred<{ content: string }>()
  const cancelFailure = new Error('取消失败')
  const cleanupFailure = new Error('清理失败')
  let released = false
  const run = await startInProcessRun(request(controller.signal), async () => ({
    id: subagentRunId('one'), agent: { run: () => task.promise, cancel() { throw cancelFailure } },
    async dispose() { released = true; task.reject(new LlmError('停止', 'ABORTED')); throw cleanupFailure },
  }))
  controller.abort()
  await assert.rejects(run.result, error => error === cancelFailure)
  await assert.rejects(run.dispose(), error => error instanceof AggregateError && error.errors[0] === cancelFailure && error.errors[1] === cleanupFailure)
  assert.equal(released, true)
})
