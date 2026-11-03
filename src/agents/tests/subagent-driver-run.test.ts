import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LlmError } from '@fly-novel/llm'
import { subagentRunId, type SubagentStartRequest } from '@fly-novel/subagent'
import { startInProcessRun, type InProcessAgentHandle, type InProcessRunDriver } from '@fly-novel/subagent-in-process-driver'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

const request = (signal = new AbortController().signal): SubagentStartRequest => ({
  parent: { info: { identity: { id: 'parent' } } }, prompt: '原始任务\n请分析', signal,
})
const driver: InProcessRunDriver = startInProcessRun

test('提交原始任务并先返回运行句柄，再返回子 Agent 的输出', async () => {
  const outcome = deferred<{ content: string }>()
  let input = ''
  let released = 0
  const handle: InProcessAgentHandle = {
    id: subagentRunId('run-1'),
    agent: { run(value) { input = value.prompt; return outcome.promise }, cancel() {} },
    async dispose() { released++ },
  }
  const run = await driver(request(), async () => handle)
  assert.equal(run.id, handle.id)
  assert.equal(input, '原始任务\n请分析')
  let finished = false
  void run.result.then(() => { finished = true })
  await Promise.resolve()
  assert.equal(finished, false)
  outcome.resolve({ content: '子 Agent 的答案' })
  assert.deepEqual(await run.result, { output: '子 Agent 的答案', stopReason: 'completed' })
  await run.dispose()
  assert.equal(released, 1)
})

test('空输出仍是成功结果，完成后的取消不改变结果', async () => {
  const controller = new AbortController()
  let cancelled = false
  const run = await driver(request(controller.signal), async () => ({
    id: subagentRunId('empty'), agent: { async run() { return { content: '' } }, cancel() { cancelled = true } }, async dispose() {},
  }))
  assert.deepEqual(await run.result, { output: '', stopReason: 'completed' })
  controller.abort()
  assert.equal(cancelled, false)
  assert.deepEqual(await run.result, { output: '', stopReason: 'completed' })
  await run.dispose()
})

test('已知 LLM 任务失败保留错误码，不暴露异常消息', async () => {
  const run = await driver(request(), async () => ({
    id: subagentRunId('failed'), agent: { async run() { throw new LlmError('敏感消息', 'RATE_LIMIT') }, cancel() {} }, async dispose() {},
  }))
  assert.deepEqual(await run.result, { output: '', stopReason: 'error', errorCode: 'RATE_LIMIT' })
  await run.dispose()
})

test('运行中取消传给 Agent，明确的 ABORTED 结果映射为取消', async () => {
  const controller = new AbortController()
  const outcome = deferred<{ content: string }>()
  let calls = 0
  const run = await driver(request(controller.signal), async () => ({
    id: subagentRunId('cancelled'), agent: { run() { return outcome.promise }, cancel() { calls++; outcome.reject(new LlmError('已取消', 'ABORTED')) } }, async dispose() {},
  }))
  controller.abort()
  assert.deepEqual(await run.result, { output: '', stopReason: 'aborted' })
  await run.dispose()
  assert.equal(calls, 1)
})

test('未知异常和包含持久化失败的聚合异常由结果 Promise 原样拒绝', async () => {
  const errors = [new Error('基础设施失败'), new AggregateError([new LlmError('已取消', 'ABORTED'), new Error('持久化失败')], '任务及持久化失败')]
  for (const failure of errors) {
    const run = await driver(request(), async () => ({
      id: subagentRunId('fault'), agent: { async run() { throw failure }, cancel() {} }, async dispose() {},
    }))
    await assert.rejects(run.result, error => error === failure)
    await run.dispose()
  }
})

test('取消时如果任务和持久化共同失败，不把聚合异常隐藏为取消', async () => {
  const controller = new AbortController()
  const outcome = deferred<{ content: string }>()
  const failure = new AggregateError([new LlmError('已取消', 'ABORTED'), new Error('持久化失败')], '任务及持久化失败')
  const run = await driver(request(controller.signal), async () => ({
    id: subagentRunId('cancel-fault'), agent: { run() { return outcome.promise }, cancel() { outcome.reject(failure) } }, async dispose() {},
  }))
  controller.abort()
  await assert.rejects(run.result, error => error === failure)
  await run.dispose()
})

test('任务结果拒绝与句柄释放失败分别可观察', async () => {
  const taskFailure = new Error('运行故障')
  const cleanupFailure = new Error('释放故障')
  const run = await driver(request(), async () => ({
    id: subagentRunId('both'), agent: { async run() { throw taskFailure }, cancel() {} }, async dispose() { throw cleanupFailure },
  }))
  await assert.rejects(run.result, error => error === taskFailure)
  await assert.rejects(run.dispose(), error => error === cleanupFailure)
})
