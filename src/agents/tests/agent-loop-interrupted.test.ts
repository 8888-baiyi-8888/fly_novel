import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { LlmAdapter, createAssistantMessage, type GenerateOptions, type StreamChunk, type ToolCallId } from '@fly-novel/llm'
import { Session } from '@fly-novel/session'
import { bootstrapAgents, jsonlSessionPersistencePlugin } from '@fly-novel/agents'
import { defineTool } from '@fly-novel/tools'
import type { Session as SessionType } from '@fly-novel/session'
import { interruptedTurnClosers } from '../plugins/loop/interrupted-turn.js'

class Adapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '继续' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

test('恢复中断工具调用并保留工具结果状态', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fly-interrupted-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const framework = await bootstrapAgents()
  const backend = framework.context.plugin(jsonlSessionPersistencePlugin, { root: directory })
  await backend
  t.after(async () => { await framework.manager.disposeAll(); await backend.dispose() })
  const handle = await framework.context.sessionPersistence.create({ id: 'crash', createdAt: '2026-01-01T00:00:00.000Z', toolCallCheckpoint: true })
  const source = new Session({ id: 'crash' })
  const a = 'call-a' as ToolCallId
  const b = 'call-b' as ToolCallId
  source.append('turn/start', { turn: 1 })
  source.append('step/start', { turn: 1, step: 1 })
  source.append('assistant/message', { turn: 1, step: 1, message: createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [
    { type: 'tool-call', id: a, name: 'first', arguments: '{}' }, { type: 'tool-call', id: b, name: 'second', arguments: '{}' },
  ] }) })
  source.append('tool/call', { turn: 1, step: 1, callId: a, name: 'first', arguments: '{}' })
  await handle.append(source.read())
  await handle.close()
  const adapter = new Adapter()
  const agent = await framework.manager.create({ id: 'character', presetId: 'character-agent', pluginConfigs: {
    'agent-loop-runtime': { provider: 'test', model: 'test', resumeSessionId: 'crash' },
    llm: { adapters: [{ providers: ['test'], adapter }] },
  } })
  const session = agent.context.sessions.list()[0]!
  assert.deepEqual(session.read().filter(event => event.type === 'tool/result').map(event => [event.data.message.source.callId, event.data.error?.code]),
    [['call-a', 'TOOL_OUTCOME_UNKNOWN'], ['call-b', 'TOOL_NOT_STARTED']])
  assert.deepEqual(session.read().filter(event => event.type === 'turn/end').map(event => event.data.reason), [{ kind: 'interrupted' }])
  await agent.run({ prompt: '继续' })
  assert.equal(adapter.requests.length, 1)
  await framework.manager.dispose('character')
  const again = await framework.context.sessionPersistence.open('crash', 'read')
  assert.equal((await again.read()).events.filter(event => event.type === 'tool/result').length, 2)
  await again.close()
  const resumed = await framework.manager.create({ id: 'again', presetId: 'character-agent', pluginConfigs: {
    'agent-loop-runtime': { provider: 'test', model: 'test', resumeSessionId: 'crash' },
    llm: { adapters: [{ providers: ['test'], adapter }] },
  } })
  assert.equal(resumed.context.sessions.list()[0]?.read().filter(event => event.type === 'tool/result').length, 2)
})

test('没有工具检查点依据的旧会话保守标记结果未知', () => {
  const session = new Session({ id: 'old' })
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', { turn: 1, step: 1, message: createAssistantMessage({ source: { provider: 'test', model: 'test' },
    content: [{ type: 'tool-call', id: 'call' as ToolCallId, name: 'action', arguments: '{}' }] }) })
  const results = interruptedTurnClosers(session.read(), false)
  assert.deepEqual(results.filter(event => event.type === 'tool/result').map(event => event.data.error?.code), ['TOOL_OUTCOME_UNKNOWN'])
  session.close()
})

test('旧 v1 日志迁移保留原文件，残缺尾部只恢复完整前缀', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fly-session-v1-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const { Context } = await import('@deepseek-ai/cordis')
  const root = new Context()
  const scope = root.plugin(jsonlSessionPersistencePlugin, { root: directory })
  await scope
  t.after(() => scope.dispose())
  const dir = join(directory, `s-${Buffer.from('old').toString('base64url')}`)
  await mkdir(dir)
  const old = `${JSON.stringify({ type: 'session', version: 1, id: 'old', createdAt: '2026-01-01T00:00:00.000Z' })}\n${JSON.stringify({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } })}\n{"type":`
  const oldFile = join(dir, 'session.v1.jsonl')
  await writeFile(oldFile, old)
  const handle = await root.sessionPersistence.open('old', 'write')
  assert.equal((await handle.read()).events.length, 1)
  await handle.close()
  assert.equal(await readFile(oldFile, 'utf8'), old)
  assert.match(await readFile(join(dir, 'session.v2.jsonl'), 'utf8'), /"version":2/)
})

test('工具开始记录刷新失败时不执行工具', async (t) => {
  const framework = await bootstrapAgents()
  t.after(() => framework.manager.disposeAll())
  framework.presets.register({ id: 'checkpoint', version: '1', role: 'character', plugins: [
    { pluginId: 'agent-loop-runtime', config: { provider: 'test', model: 'test', workingDirectory: '.' } },
    { pluginId: 'session' }, { pluginId: 'system-prompt' }, { pluginId: 'llm' }, { pluginId: 'tools' },
  ] })
  class CallingAdapter extends LlmAdapter {
    override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call' as ToolCallId, name: 'action', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
  }
  const agent = await framework.manager.create({ id: 'checkpoint', presetId: 'checkpoint', pluginConfigs: {
    llm: { adapters: [{ providers: ['test'], adapter: new CallingAdapter() }] },
  } })
  let executed = false
  agent.context.tools.register(defineTool({ name: 'action', description: '测试', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() { executed = true; return 'done' },
  }))
  const original = agent.context.sessions.flush.bind(agent.context.sessions)
  const mock = t.mock.method(agent.context.sessions, 'flush', async (session: SessionType) => {
    if (session.read().some(event => event.type === 'tool/call')) throw new Error('checkpoint failure')
    await original(session)
  })
  await assert.rejects(agent.run({ prompt: '执行' }), error => error instanceof AggregateError
    && error.errors.some((cause: unknown) => cause instanceof Error && cause.message === 'checkpoint failure'))
  assert.equal(executed, false)
  mock.mock.restore()
})

test('持久化后端卸载后 Loop 拒绝后续运行', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fly-backend-stop-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const framework = await bootstrapAgents()
  t.after(() => framework.manager.disposeAll())
  const backend = framework.context.plugin(jsonlSessionPersistencePlugin, { root: directory })
  await backend
  const adapter = new Adapter()
  const agent = await framework.manager.create({ id: 'character', presetId: 'character-agent', pluginConfigs: {
    'agent-loop-runtime': { provider: 'test', model: 'test', sessionId: 'backend-stop' },
    llm: { adapters: [{ providers: ['test'], adapter }] },
  } })
  await backend.dispose()
  await assert.rejects(agent.run({ prompt: '继续' }), /持久化后端不可用/)
  assert.equal(adapter.requests.length, 0)
})
