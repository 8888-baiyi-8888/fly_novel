import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAssistantMessage, createSystemMessage, createToolResultMessage, createUserMessage, type ToolCallId } from '@fly-novel/llm'
import { sessionPlugin, type SessionEvent } from '@fly-novel/session'
import { jsonlSessionPersistencePlugin } from '../plugins/session-persistence-jsonl/index.js'

test('Session 事件写入真实 JSONL 并恢复模型历史', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fly-session-recovery-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const { Context } = await import('@deepseek-ai/cordis')
  const root = new Context()
  const backend = root.plugin(jsonlSessionPersistencePlugin, { root: directory })
  const sessionsScope = root.plugin(sessionPlugin)
  await backend
  await sessionsScope
  t.after(async () => { await sessionsScope.dispose(); await backend.dispose() })
  const persistence = root.sessionPersistence
  const sessions = root.sessions
  const header = { id: 'session-1', createdAt: '2026-01-01T00:00:00.000Z' }
  await persistence.create(header)
  const session = sessions.create(header.id, { createdAt: new Date(header.createdAt) })
  const callId = 'call-1' as ToolCallId
  session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('旧提示', 'test') })
  session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('新提示', 'test') })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '读取文件' }], source: { kind: 'user' } }))
  session.append('assistant/message', { turn: 1, step: 1, message: createAssistantMessage({
    source: { provider: 'test', model: 'test' }, content: [{ type: 'tool-call', id: callId, name: 'read_file', arguments: '{}' }],
  }) })
  session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId, content: [{ type: 'text', text: '文件内容' }] }) })
  const expected = session.read()
  const messages = session.deriveMessages()
  await sessions.flush(session)
  await sessions.close(session.id)
  const handle = await persistence.open(header.id, 'write')
  const stored = (await handle.read()).events
  assert.deepEqual(stored, expected)
  assert.throws(() => sessions.create('invalid', { seed: stored.slice(0, -1) }), /缺少关联结果/)
  const restored = sessions.create(header.id, { createdAt: new Date(handle.header.createdAt), seed: stored })
  assert.deepEqual(restored.deriveMessages(), messages)
  const next = restored.append('turn/start', { turn: 2 })
  assert.equal(next.seq, expected.length)
  await sessions.close(restored.id)
  const reader = await persistence.open(header.id, 'read')
  assert.deepEqual((await reader.read()).events, [...expected, next])
  await reader.close()
})

test('异步写入失败后保留事件并在下次 flush 重试', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fly-session-retry-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const { Context } = await import('@deepseek-ai/cordis')
  const root = new Context()
  const backend = root.plugin(jsonlSessionPersistencePlugin, { root: directory })
  const sessionsScope = root.plugin(sessionPlugin)
  await backend
  await sessionsScope
  t.after(async () => { await sessionsScope.dispose(); await backend.dispose() })
  const writer = await root.sessionPersistence.create({ id: 'retry', createdAt: '2026-01-01T00:00:00.000Z' })
  const append = writer.append.bind(writer)
  let failed = false
  t.mock.method(writer, 'append', async (events: readonly SessionEvent[]) => {
    if (!failed) { failed = true; throw new Error('写入失败') }
    return append(events)
  })
  const session = root.sessions.create('retry')
  const event = session.append('turn/start', { turn: 1 })
  await assert.rejects(root.sessions.flush(session), error => error instanceof AggregateError
    && error.errors.some((cause: unknown) => cause instanceof Error && cause.message === '写入失败'))
  await root.sessions.flush(session)
  assert.deepEqual((await writer.read()).events, [event])
  await root.sessions.close('retry')
})

test('关闭期间拒绝追加并等待待写事件', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fly-session-close-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const { Context } = await import('@deepseek-ai/cordis')
  const root = new Context()
  const backend = root.plugin(jsonlSessionPersistencePlugin, { root: directory })
  const scope = root.plugin(sessionPlugin)
  await backend; await scope
  t.after(async () => { await scope.dispose(); await backend.dispose() })
  const writer = await root.sessionPersistence.create({ id: 'close', createdAt: '2026-01-01T00:00:00.000Z' })
  const append = writer.append.bind(writer)
  let release: () => void = () => undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  t.mock.method(writer, 'append', async (events: readonly SessionEvent[]) => { await gate; await append(events) })
  const session = root.sessions.create('close')
  const event = session.append('turn/start', { turn: 1 })
  const closing = root.sessions.close(session.id)
  assert.throws(() => session.append('turn/start', { turn: 2 }), /正在关闭/)
  release()
  assert.equal(await closing, true)
  const reader = await root.sessionPersistence.open('close', 'read')
  assert.deepEqual((await reader.read()).events, [event])
  await reader.close()
})
