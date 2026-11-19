import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SharedResource } from '../storage/resource.js'

test('并发借用只打开一次，关闭等待打开且拒绝新借用', async () => {
  let complete!: () => void
  const opening = new Promise<void>(resolve => { complete = resolve })
  let opened = 0; let closed = 0
  const value = { name: '共享存储' }
  const resource = new SharedResource(async () => { opened++; await opening; return { value, async close() { closed++ } } })
  const first = resource.get(); const second = resource.get()
  const closing = resource.close()
  await assert.rejects(resource.get(), /关闭/)
  complete()
  assert.equal(await first, value); assert.equal(await second, value)
  await Promise.all([closing, resource.close()])
  assert.equal(opened, 1); assert.equal(closed, 1)
})

test('普通打开失败可重试，清理失败保留错误且禁止盲目重试', async () => {
  let attempts = 0
  const resource = new SharedResource(async () => {
    attempts++
    if (attempts === 1) throw new Error('打开失败')
    return { value: 1, async close() {} }
  })
  await assert.rejects(resource.get(), /打开失败/)
  assert.equal(await resource.get(), 1)
  await resource.close()
  let failedAttempts = 0
  const failure = new SharedResource(async () => { failedAttempts++; throw new AggregateError([new Error('清理失败')], '资源状态未知') })
  await assert.rejects(failure.get(), /资源状态未知/)
  await assert.rejects(failure.get(), /资源状态未知/)
  await assert.rejects(failure.close(), /资源状态未知/)
  assert.equal(failedAttempts, 1)
})
