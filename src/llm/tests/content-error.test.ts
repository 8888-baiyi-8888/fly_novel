import assert from 'node:assert/strict'
import { test } from 'node:test'
import { contentHasFile, contentHasImage, projectFilesToText, projectImagesForTextModel } from '../content'
import { freezeMessage, type Message } from '../message'
import type { AttachmentId, MessageId, ToolCallId } from '../brand'

import { LlmError } from '../error'
import { normalizeLlmFailure } from '../adapter-failure'

test('嵌套工具结果中的附件按模型能力投影，原消息保持不变', () => {
  const messages: Message[] = [freezeMessage({
    id: 'message' as MessageId, role: 'user', source: { kind: 'user' },
    content: [{ type: 'tool-result', toolCallId: 'call' as ToolCallId, content: [
      { type: 'file', attachment: { attachmentId: 'sha256:12345678' as AttachmentId, name: 'file.txt', bytes: 10 } },
      { type: 'image', attachment: { attachmentId: 'sha256:87654321' as AttachmentId, bytes: 20, mediaType: 'image/png', width: 2, height: 3 } },
    ] }],
  })]
  assert.equal(contentHasFile(messages[0].content), true)
  assert.equal(contentHasImage(messages[0].content), true)
  const files = projectFilesToText(messages, () => '/readonly/file.txt')
  assert.equal(contentHasFile(files[0].content), false)
  assert.ok(JSON.stringify(files).includes('/readonly/file.txt'))
  const text = projectImagesForTextModel(files)
  assert.equal(contentHasImage(text[0].content), false)
  assert.equal(contentHasFile(messages[0].content), true)
  assert.equal(contentHasImage(messages[0].content), true)
  assert.equal(projectImagesForTextModel(text), text)
  assert.equal(projectFilesToText(text, () => undefined), text)
})

test('失败快照保留供应商信息，拒绝错误的卸载数量，不调用 failure 访问器', () => {
  for (const count of [0, -1, 1.2, Infinity]) {
    assert.throws(() => new LlmError('失败', 'IMAGE_OFFLOAD_REQUIRED', { offloadImages: count }), /offloadImages/)
  }
  assert.throws(() => new LlmError('失败', 'UNKNOWN', { offloadImages: 1 }), /offloadImages/)
  const error = new LlmError('需卸载', 'IMAGE_OFFLOAD_REQUIRED', { offloadImages: 2 })
  const failure = normalizeLlmFailure(error)
  assert.deepEqual(failure, error.failure)
  assert.notEqual(failure, error.failure)
  assert.ok(Object.isFrozen(failure))
  const external = new Error('SDK 失败')
  Object.defineProperty(external, 'failure', { get() { assert.fail('不应读取访问器') } })
  assert.deepEqual(normalizeLlmFailure(external), { message: 'SDK 失败', code: 'UNKNOWN' })
  assert.equal(normalizeLlmFailure({ toString() { throw new Error('转换失败') } }).code, 'UNKNOWN')
})
