import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerAll } from '../register-all.js'

test('按顺序批量注册，失败时停止并保留已完成的注册', () => {
  const registered: string[] = []
  assert.throws(() => registerAll(['one', 'two', 'three'], item => {
    if (item === 'two') throw new Error('注册失败')
    registered.push(item)
  }), /注册失败/)
  assert.deepEqual(registered, ['one'])
})
