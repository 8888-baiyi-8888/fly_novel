import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deepFreeze } from '../deep-freeze'

test('深度冻结支持循环引用，取消信号仍可更新', () => {
  const controller = new AbortController()
  const value: { signal: AbortSignal; nested: { count: number }; self?: unknown } = { signal: controller.signal, nested: { count: 1 } }
  value.self = value
  assert.equal(deepFreeze(value), value)
  assert.ok(Object.isFrozen(value.nested))
  controller.abort()
  assert.equal(value.signal.aborted, true)
})
