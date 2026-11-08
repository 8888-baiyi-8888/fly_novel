import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { LocalSubprocessRuntime } from '@fly-novel/subprocess-local'
import { deadline, timeoutOf } from '@fly-novel/timeout'

test('期限终止子进程并保留原因，释放期限后不再触发', async t => {
  const ctx = new Context()
  const scope = ctx.plugin(LocalSubprocessRuntime); await scope
  t.after(() => scope.dispose())
  const limit = deadline(undefined, 100, 'SEARCH_TIMEOUT')
  t.after(() => limit[Symbol.dispose]())
  const handle = ctx.subprocess.spawn({ argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'], cwd: process.cwd(), stdio: { stdin: 'ignore', stdout: { maxBytes: 128 }, stderr: { maxBytes: 128 } }, graceMs: 100, signal: limit.signal })
  await handle.done
  assert.equal(timeoutOf(limit.signal, 'SEARCH_TIMEOUT')?.timeoutMs, 100)
  assert.equal(await handle.waitForExit(), true)
  const released = deadline(undefined, 20, 'SEARCH_TIMEOUT')
  released[Symbol.dispose]()
  await delay(40)
  assert.equal(released.signal.aborted, false)
})

test('上游取消先发生时保留其原因', () => {
  const controller = new AbortController()
  const limit = deadline(controller.signal, 100, 'SEARCH_TIMEOUT')
  controller.abort(new Error('caller'))
  assert.equal(timeoutOf(limit.signal), undefined)
  assert.equal((limit.signal.reason as Error).message, 'caller')
  limit[Symbol.dispose]()
})
