import assert from 'node:assert/strict'
import test from 'node:test'
import { SystemPrompt } from '../plugins/system-prompt/index.js'

test('SystemPrompt saves and returns prompt text', () => {
  const systemPrompt = new SystemPrompt()

  systemPrompt.setPrompt('你是写作助手。')

  assert.equal(systemPrompt.getPrompt(), '你是写作助手。')
})

test('SystemPrompt can replace the saved prompt', () => {
  const systemPrompt = new SystemPrompt()

  systemPrompt.setPrompt('你是写作助手。')
  systemPrompt.setPrompt('回答应简洁。')

  assert.equal(systemPrompt.getPrompt(), '回答应简洁。')
})

test('SystemPrompt returns an empty string before a prompt is set', () => {
  const systemPrompt = new SystemPrompt()

  assert.equal(systemPrompt.getPrompt(), '')
})

test('SystemPrompt registers and reads named sections', () => {
  const systemPrompt = new SystemPrompt()
  const section = { name: 'identity', order: 10, text: '你是写作助手。' }

  systemPrompt.section(section)

  assert.deepEqual(systemPrompt.getSection('identity'), section)
  assert.deepEqual(systemPrompt.listSections(), [section])
})

test('SystemPrompt rejects duplicate names and invalid section definitions', () => {
  const systemPrompt = new SystemPrompt()
  systemPrompt.section({ name: 'identity', order: 10, text: '你是写作助手。' })

  assert.throws(
    () => systemPrompt.section({ name: 'identity', order: 20, text: '其他身份。' }),
    /已注册/,
  )
  assert.throws(
    () => systemPrompt.section({ name: ' ', order: 10, text: '空名称。' }),
    /name 不能为空/,
  )
  assert.throws(
    () => systemPrompt.section({ name: 'invalid-order', order: Number.NaN, text: '无效顺序。' }),
    /有限数值/,
  )
})

test('section disposer unregisters only the registration that created it', () => {
  const systemPrompt = new SystemPrompt()
  const disposeFirst = systemPrompt.section({ name: 'identity', order: 10, text: '初始身份。' })

  disposeFirst()
  assert.equal(systemPrompt.getSection('identity'), undefined)

  const disposeSecond = systemPrompt.section({ name: 'identity', order: 10, text: '新身份。' })
  disposeFirst()
  assert.equal(systemPrompt.getSection('identity')?.text, '新身份。')

  disposeSecond()
  assert.deepEqual(systemPrompt.listSections(), [])
})
