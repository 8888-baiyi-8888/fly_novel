import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ToolCallId } from '../brand'
import { createAssistantMessage, createMessage, createSystemMessage, createToolResultMessage, createUserMessage, freezeMessage } from '../message'

test('创建消息时生成唯一标识并冻结消息快照', () => {
  const input = { role: 'system' as const, source: { kind: 'plugin' as const, plugin: 'test' }, content: [{ type: 'text' as const, text: '提示' }] }
  const first = createMessage(input)
  const second = createMessage(input)

  assert.notEqual(first.id, second.id)
  assert.equal(Object.isFrozen(first), true)
  assert.equal(Object.isFrozen(first.source), true)
  assert.equal(Object.isFrozen(first.content), true)
  assert.equal(Object.isFrozen(first.content[0]), true)
})

test('用户和助手消息工厂固定消息标签并保留来源数据', () => {
  const user = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] })
  const assistant = createAssistantMessage({
    source: { provider: 'deepseek', model: 'deepseek-chat', replayState: { response: { id: 'response' } } },
    content: [{ type: 'text', text: '你好' }],
  })

  assert.equal(user.role, 'user')
  assert.deepEqual(user.source, { kind: 'user' })
  assert.equal(assistant.role, 'assistant')
  assert.deepEqual(assistant.source, {
    kind: 'model', provider: 'deepseek', model: 'deepseek-chat', replayState: { response: { id: 'response' } },
  })
  assert.equal(Object.isFrozen(user), true)
  assert.equal(Object.isFrozen(assistant), true)
})

test('freezeMessage 保留已有消息标识', () => {
  const message = createUserMessage({ source: { kind: 'user' }, content: [] })
  const snapshot = freezeMessage(message)

  assert.equal(snapshot.id, message.id)
  assert.notEqual(snapshot, message)
})

test('系统消息工厂固定插件来源并为空提示生成空内容', () => {
  const system = createSystemMessage('系统指令', 'system-prompt')
  const empty = createSystemMessage('', 'system-prompt')

  assert.equal(system.role, 'system')
  assert.deepEqual(system.source, { kind: 'plugin', plugin: 'system-prompt' })
  assert.deepEqual(system.content, [{ type: 'text', text: '系统指令' }])
  assert.deepEqual(empty.content, [])
  assert.equal(Object.isFrozen(system), true)
})

test('工具结果工厂保留调用关联、结果内容和错误状态', () => {
  const callId = 'call-1' as ToolCallId
  const result = createToolResultMessage({
    callId,
    content: [{ type: 'text', text: '工具失败' }],
    isError: true,
  })

  assert.equal(result.role, 'user')
  assert.deepEqual(result.source, { kind: 'tool', callId })
  assert.deepEqual(result.content, [{
    type: 'tool-result', toolCallId: callId,
    content: [{ type: 'text', text: '工具失败' }], isError: true,
  }])
  assert.equal(Object.isFrozen(result.content[0]?.content), true)
})
