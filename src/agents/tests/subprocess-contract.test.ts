import assert from 'node:assert/strict'
import test from 'node:test'
import { scrubbedParentEnv } from '@fly-novel/subprocess'

test('子进程默认环境过滤凭据和保留命名空间', () => {
  const keys = ['FLY_TEST_PASSWORD', 'dsh_test_plain', 'FLY_TEST_PLAIN'] as const
  const original = keys.map(key => process.env[key])
  try {
    for (const key of keys) process.env[key] = 'value'
    const env = scrubbedParentEnv()
    assert.equal(env.FLY_TEST_PASSWORD, undefined)
    assert.equal(env.dsh_test_plain, undefined)
    assert.equal(env.FLY_TEST_PLAIN, 'value')
  } finally {
    keys.forEach((key, index) => {
      const value = original[index]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    })
  }
})
