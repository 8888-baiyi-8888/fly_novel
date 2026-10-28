import assert from 'node:assert/strict'
import test from 'node:test'
import { bootstrapAgents } from '../core/bootstrap.js'
import { createTestAgent, withAgentLoop } from './agent-loop-fixtures.js'
import { renderPrompt, SystemPrompt } from '@fly-novel/system-prompt'

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
    /当前作用域注册/,
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

test('dynamic section text is evaluated during assembly and remains in its snapshot', () => {
  const systemPrompt = new SystemPrompt()
  let currentFact = '第一轮事实'
  systemPrompt.section({
    name: 'fact',
    order: 0,
    text: () => currentFact,
  })

  const assembly = systemPrompt.assemble()
  currentFact = '第二轮事实'

  assert.equal(renderPrompt(assembly), '第一轮事实')
  assert.equal(renderPrompt(systemPrompt.assemble()), '第二轮事实')
})

test('variables are resolved during assembly and interpolated during rendering', () => {
  const systemPrompt = new SystemPrompt()
  let language = '中文'
  let variableCalls = 0
  systemPrompt.variable('response_language', () => {
    variableCalls += 1
    return language
  })
  systemPrompt.section({ name: 'instructions', order: 0, text: '请使用{{response_language}}回答。' })

  const assembly = systemPrompt.assemble()
  language = 'English'

  assert.equal(variableCalls, 1)
  assert.equal(renderPrompt(assembly), '请使用中文回答。')
  assert.equal(renderPrompt(systemPrompt.assemble()), '请使用English回答。')
})

test('interpolate false preserves variable syntax literally', () => {
  const systemPrompt = new SystemPrompt()
  systemPrompt.section({ name: 'literal', order: 0, text: '模板 {{unknown}}', interpolate: false })

  assert.equal(renderPrompt(systemPrompt.assemble()), '模板 {{unknown}}')
})

test('variable registration validates names and rejects duplicate names', () => {
  const systemPrompt = new SystemPrompt()
  systemPrompt.variable('language', () => '中文')

  assert.throws(() => systemPrompt.variable('language', () => 'English'), /当前作用域注册/)
  assert.throws(() => systemPrompt.variable('Invalid-Name', () => '值'), /名称无效/)
})

test('renderPrompt rejects malformed, unknown, and undefined variables', () => {
  const malformed = new SystemPrompt()
  malformed.section({ name: 'malformed', order: 0, text: '错误 {{name space}}' })
  assert.throws(() => renderPrompt(malformed.assemble()), /无效变量/)

  const unknown = new SystemPrompt()
  unknown.section({ name: 'unknown', order: 0, text: '未知 {{missing}}' })
  assert.throws(() => renderPrompt(unknown.assemble()), /未注册变量/)

  const missingValue = new SystemPrompt()
  missingValue.variable('optional', () => undefined)
  missingValue.section({ name: 'missing-value', order: 0, text: '空值 {{optional}}' })
  assert.throws(() => renderPrompt(missingValue.assemble()), /未提供值/)
})

test('scoped sections shadow globals without affecting other scopes', () => {
  const systemPrompt = new SystemPrompt()
  systemPrompt.section({ name: 'identity', order: 10, text: '通用身份。' })
  systemPrompt.section({ name: 'identity', order: 10, text: '写作身份。' }, 'writer')
  systemPrompt.section({ name: 'style', order: 20, text: '回答应简洁。' }, 'writer')

  assert.equal(renderPrompt(systemPrompt.assemble()), '通用身份。')
  assert.equal(renderPrompt(systemPrompt.assemble({ scope: 'writer' })), '写作身份。\n\n回答应简洁。')
  assert.deepEqual(systemPrompt.listSections('writer').map(({ name }) => name), ['identity', 'style'])
  assert.equal(systemPrompt.getSection('identity', 'writer')?.text, '写作身份。')
})

test('variables are isolated by scope and scoped providers shadow globals', () => {
  const systemPrompt = new SystemPrompt()
  systemPrompt.variable('response_language', () => '通用语言')
  systemPrompt.variable('response_language', () => '中文', 'writer')
  systemPrompt.section({ name: 'instruction', order: 0, text: '使用{{response_language}}。' })

  assert.equal(renderPrompt(systemPrompt.assemble()), '使用通用语言。')
  assert.equal(renderPrompt(systemPrompt.assemble({ scope: 'writer' })), '使用中文。')

  const sameProvider = () => '保留'
  const disposeOld = systemPrompt.variable('same', sameProvider, 'agent')
  disposeOld()
  const disposeNew = systemPrompt.variable('same', sameProvider, 'agent')
  disposeOld()
  systemPrompt.section({ name: 'same-value', order: 0, text: '{{same}}' }, 'agent')
  assert.equal(renderPrompt(systemPrompt.assemble({ scope: 'agent' })), '使用通用语言。\n\n保留')
  disposeNew()
})

test('complete section replaces other active sections only in its scope', () => {
  const systemPrompt = new SystemPrompt()
  systemPrompt.section({ name: 'identity', order: 0, text: '通用身份。' })
  systemPrompt.section({ name: 'policy', order: 10, text: '通用规则。' })
  systemPrompt.section({ name: 'full', order: 0, text: '完整提示词。', complete: true }, 'writer')

  assert.equal(renderPrompt(systemPrompt.assemble()), '通用身份。\n\n通用规则。')
  assert.equal(renderPrompt(systemPrompt.assemble({ scope: 'writer' })), '完整提示词。')
})

test('assembly rejects multiple effective complete sections', () => {
  const systemPrompt = new SystemPrompt()
  systemPrompt.section({ name: 'global-full', order: 0, text: '全局完整。', complete: true })
  systemPrompt.section({ name: 'scoped-full', order: 10, text: '作用域完整。', complete: true }, 'writer')

  assert.throws(() => systemPrompt.assemble({ scope: 'writer' }), /多个完整提示词段同时生效/)
})

test('Cordis plugin isolates SystemPrompt per Agent and disposes it with the Agent', async () => {
  const framework = await bootstrapAgents()
  try {
    assert.ok(framework.plugins.get('system-prompt'))
    framework.presets.register({
      id: 'system-prompt-test',
      version: '1',
      role: 'character',
      plugins: withAgentLoop([]),
    })

    const first = await createTestAgent(framework, { id: 'prompt-agent-a', presetId: 'system-prompt-test' })
    const second = await createTestAgent(framework, { id: 'prompt-agent-b', presetId: 'system-prompt-test' })
    const firstPrompt = first.context.get('systemPrompt')
    const secondPrompt = second.context.get('systemPrompt')
    assert.ok(firstPrompt)
    assert.ok(secondPrompt)
    assert.notEqual(firstPrompt, secondPrompt)

    firstPrompt.section({ name: 'identity', order: 0, text: '仅 Agent A 可见。' })
    secondPrompt.section({ name: 'identity', order: 0, text: '仅 Agent B 可见。' })
    assert.equal(renderPrompt(firstPrompt.assemble()), '仅 Agent A 可见。')
    assert.equal(renderPrompt(secondPrompt.assemble()), '仅 Agent B 可见。')

    await framework.manager.dispose('prompt-agent-a')
    assert.equal(first.context.get('systemPrompt'), undefined)
    assert.throws(() => firstPrompt.assemble(), /已销毁/)
    assert.equal(renderPrompt(secondPrompt.assemble()), '仅 Agent B 可见。')
  } finally {
    await framework.manager.disposeAll()
  }
})
