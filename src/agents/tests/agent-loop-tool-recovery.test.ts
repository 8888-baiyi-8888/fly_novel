import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { LlmAdapter, type GenerateOptions, type StreamChunk, type ToolCallId } from '@fly-novel/llm'
import { bootstrapAgents } from '@fly-novel/agents'
import type { SessionEventMap, SessionEventType } from '@fly-novel/session'
import type { ToolBatchInput } from '@fly-novel/tools'
import { readFileTool } from '../../tools/filesystem/read-file.js'

class RecoveryAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.requests.length === 1) {
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-1' as ToolCallId,
        name: 'read_file', arguments: '{"path":"outline.txt"}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '继续' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

async function setup(t: TestContext, register = true) {
  const framework = await bootstrapAgents()
  t.after(() => framework.manager.disposeAll())
  const adapter = new RecoveryAdapter()
  framework.presets.register({ id: 'recovery', version: '1', role: 'character', plugins: [
    { pluginId: 'agent-loop-runtime', config: { provider: 'test', model: 'test', workingDirectory: '.' } },
    { pluginId: 'session' }, { pluginId: 'system-prompt' }, { pluginId: 'llm' }, { pluginId: 'tools' },
  ] })
  const agent = await framework.manager.create({ id: 'recovery', presetId: 'recovery',
    pluginConfigs: { llm: { adapters: [{ providers: ['test'], adapter }] } } })
  if (register) agent.context.tools.register(readFileTool)
  const session = agent.context.sessions.list()[0]
  assert.ok(session)
  return { agent, adapter, session }
}

test('执行器异常后补齐结果未知记录，后续请求包含配对结果', async (t) => {
  const { agent, adapter, session } = await setup(t)
  const mock = t.mock.method(agent.context.tools, 'execute', async (input: ToolBatchInput) => {
    const call = input.calls[0]!
    session.append('tool/call', { turn: 1, step: 1, callId: call.id, name: call.name, arguments: call.arguments })
    throw new Error('执行器中断')
  })
  await assert.rejects(agent.run({ prompt: '第一次' }), /执行器中断/)
  const results = session.read().filter(event => event.type === 'tool/result')
  assert.equal(results.length, 1)
  assert.deepEqual(results[0]?.data.error, { name: 'ToolOutcomeUnknownError', code: 'TOOL_OUTCOME_UNKNOWN' })
  assert.equal(results[0]?.data.message.source.callId, 'call-1')
  mock.mock.restore()
  assert.deepEqual(await agent.run({ prompt: '继续' }), { content: '继续' })
  const messages = adapter.requests[1]?.messages
  assert.ok(messages)
  assert.deepEqual(messages.map(message => message.role), ['user', 'assistant', 'user', 'user'])
  const block = messages[2]?.content[0]
  assert.ok(block?.type === 'tool-result')
  assert.equal(block.toolCallId, 'call-1')
  assert.equal(block.isError, true)
  assert.equal(session.read().filter(event => event.type === 'tool/result').length, 1)
})

test('工具结果 ID 不匹配时拒绝错配并补齐原调用的结果', async (t) => {
  const { agent, session } = await setup(t)
  t.mock.method(agent.context.tools, 'execute', async (input: ToolBatchInput) => {
    const call = input.calls[0]!
    session.append('tool/call', { turn: 1, step: 1, callId: call.id, name: call.name, arguments: call.arguments })
    return { results: [{ callId: 'wrong' as ToolCallId,
      result: { isError: false as const, value: 'x', content: [{ type: 'text' as const, text: 'x' }] } }] }
  })
  await assert.rejects(agent.run({ prompt: '读取' }), /工具结果与调用 ID 不匹配/)
  const results = session.read().filter(event => event.type === 'tool/result')
  assert.equal(results.length, 1)
  assert.equal(results[0]?.data.message.source.callId, 'call-1')
  assert.equal(results[0]?.data.error?.code, 'TOOL_OUTCOME_UNKNOWN')
})

test('工具开始记录失败时补齐未开始结果', async (t) => {
  const { agent, session } = await setup(t)
  const append = session.append.bind(session)
  t.mock.method(session, 'append', <T extends SessionEventType>(type: T, data: SessionEventMap[T]) => {
    if (type === 'tool/call') throw new Error('无法记录工具开始')
    return append(type, data)
  })
  await assert.rejects(agent.run({ prompt: '读取' }), /无法记录工具开始/)
  const events = session.read()
  assert.equal(events.filter(event => event.type === 'tool/call').length, 0)
  const results = events.filter(event => event.type === 'tool/result')
  assert.equal(results.length, 1)
  assert.equal(results[0]?.data.message.source.callId, 'call-1')
  assert.equal(results[0]?.data.error?.code, 'TOOL_NOT_STARTED')
})

test('结果记录失败时补齐未知结果而不重复执行工具', async (t) => {
  const { agent, session } = await setup(t, false)
  let executions = 0
  agent.context.tools.register({ ...readFileTool, async execute() { executions++; return '已执行' } })
  const append = session.append.bind(session)
  let failOnce = true
  t.mock.method(session, 'append', <T extends SessionEventType>(type: T, data: SessionEventMap[T]) => {
    if (type === 'tool/result' && failOnce) { failOnce = false; throw new Error('无法记录工具结果') }
    return append(type, data)
  })
  await assert.rejects(agent.run({ prompt: '读取' }), /无法记录工具结果/)
  assert.equal(executions, 1)
  const results = session.read().filter(event => event.type === 'tool/result')
  assert.equal(results.length, 1)
  assert.equal(results[0]?.data.error?.code, 'TOOL_OUTCOME_UNKNOWN')
  assert.equal(results[0]?.data.message.source.callId, 'call-1')
})

test('工具执行中取消只记录一次取消结果并允许后续请求', async (t) => {
  const { agent, adapter, session } = await setup(t, false)
  let notifyStarted: () => void = () => undefined
  const started = new Promise<void>(resolve => { notifyStarted = resolve })
  agent.context.tools.register({ ...readFileTool, async execute(_args, exec) {
    notifyStarted()
    await new Promise<void>(resolve => exec.signal.addEventListener('abort', () => resolve(), { once: true }))
    return '已停止'
  } })
  const pending = agent.run({ prompt: '读取' })
  await started
  agent.cancel()
  await assert.rejects(pending, { code: 'ABORTED' })
  const results = session.read().filter(event => event.type === 'tool/result')
  assert.equal(results.length, 1)
  assert.equal(results[0]?.data.error?.code, 'ABORTED')
  assert.equal(results[0]?.data.message.source.callId, 'call-1')
  assert.deepEqual(await agent.run({ prompt: '继续' }), { content: '继续' })
  const block = adapter.requests[1]?.messages[2]?.content[0]
  assert.ok(block?.type === 'tool-result')
  assert.equal(block.toolCallId, 'call-1')
  assert.equal(session.read().filter(event => event.type === 'tool/result').length, 1)
})
