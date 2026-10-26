import assert from 'node:assert/strict'
import test from 'node:test'
import { renderPrompt, SystemPrompt } from '../plugins/system-prompt/index.js'

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

test('assemble sorts sections by order and then by name', () => {
  const systemPrompt = new SystemPrompt()
  systemPrompt.section({ name: 'z-last', order: 20, text: '最后。' })
  systemPrompt.section({ name: 'b-second', order: 10, text: '第二。' })
  systemPrompt.section({ name: 'a-first', order: 10, text: '第一。' })

  const assembly = systemPrompt.assemble()

  assert.deepEqual(assembly.sections.map(({ name }) => name), ['a-first', 'b-second', 'z-last'])
  assert.equal(renderPrompt(assembly), '第一。\n\n第二。\n\n最后。')
})

test('renderPrompt skips empty text and returns an empty string for no sections', () => {
  const systemPrompt = new SystemPrompt()
  assert.equal(renderPrompt(systemPrompt.assemble()), '')

  systemPrompt.section({ name: 'empty', order: 0, text: '' })
  systemPrompt.section({ name: 'text', order: 1, text: '正文。' })

  assert.equal(renderPrompt(systemPrompt.assemble()), '正文。')
})

test('assemble returns a snapshot unaffected by later registration changes', () => {
  const systemPrompt = new SystemPrompt()
  const dispose = systemPrompt.section({ name: 'identity', order: 0, text: '你是写作助手。' })
  const assembly = systemPrompt.assemble()

  dispose()
  systemPrompt.section({ name: 'behavior', order: 10, text: '回答应简洁。' })

  assert.equal(renderPrompt(assembly), '你是写作助手。')
  assert.equal(renderPrompt(systemPrompt.assemble()), '回答应简洁。')
})
