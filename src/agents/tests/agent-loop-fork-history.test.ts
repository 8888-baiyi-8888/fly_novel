import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LlmAdapter, type GenerateOptions, type StreamChunk, type ToolCallId } from '@fly-novel/llm'
import type { ForkHistorySource } from '@fly-novel/agent-loop'
import { bootstrapAgents } from '../core/bootstrap.js'
import { createTestAgent } from './agent-loop-fixtures.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(accept => { resolve = accept })
  return { promise, resolve }
}

class Adapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly entered = deferred()
  readonly release = deferred()
  constructor(private readonly gateSecond = false) { super() }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.gateSecond && this.requests.length === 2) { this.entered.resolve(); await this.release.promise }
    yield { type: 'block-start', index: 0, block: 'text' }
    yield { type: 'text-delta', index: 0, text: '回复' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '回复' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function source(value: unknown): ForkHistorySource {
  assert.ok(value && typeof value === 'object' && 'snapshotForkHistory' in value && typeof value.snapshotForkHistory === 'function')
  return value as ForkHistorySource
}

test('快照排除进行中的轮次，独立子 Session 使用自身提示并继续编号', { timeout: 3000 }, async () => {
  const framework = await bootstrapAgents()
  const adapter = new Adapter(true)
  const childAdapter = new Adapter()
  const config = (model: LlmAdapter) => ({ 'agent-loop-runtime': { provider: 'test', model: 'model' }, llm: { adapters: [{ providers: ['test'], adapter: model }] } })
  try {
    const parent = await createTestAgent(framework, { id: 'parent', presetId: 'character-agent', pluginConfigs: config(adapter) })
    const history = source(parent.context.agentLoop)
    assert.deepEqual(history.snapshotForkHistory(), [])
    await parent.run({ prompt: '第一轮' })
    const current = parent.run({ prompt: '当前轮次私有内容' })
    await adapter.entered.promise
    const snapshot = history.snapshotForkHistory()
    assert.equal(snapshot.at(-1)?.type, 'turn/end')
    assert.match(JSON.stringify(snapshot), /第一轮/)
    assert.doesNotMatch(JSON.stringify(snapshot), /当前轮次私有内容/)
    const child = await createTestAgent(framework, { id: 'child', presetId: 'generic-subagent', pluginConfigs: {
      ...config(childAdapter), 'agent-loop-runtime': { provider: 'test', model: 'model', initialSessionEvents: snapshot },
    } })
    const parentSession = parent.context.sessions.list()[0]!
    const childSession = child.context.sessions.list()[0]!
    assert.notEqual(parentSession.id, childSession.id)
    adapter.release.resolve()
    await current
    await child.run({ prompt: '子任务' })
    const messages = JSON.stringify(childAdapter.requests[0]!.messages)
    assert.match(messages, /第一轮/)
    assert.match(messages, /子任务/)
    assert.doesNotMatch(messages, /当前轮次私有内容/)
    assert.notDeepEqual(childAdapter.requests[0]!.messages[0], adapter.requests[0]!.messages[0])
    assert.deepEqual(childSession.read().filter(event => event.type === 'turn/start').map(event => event.data.turn), [1, 2])
    assert.doesNotMatch(JSON.stringify(parentSession.read()), /子任务/)
  } finally { adapter.release.resolve(); await framework.manager.disposeAll() }
})

test('拒绝未闭合历史、工具事件以及持久化和初始历史同时配置', async () => {
  const framework = await bootstrapAgents()
  const adapter = new Adapter()
  const config = { 'agent-loop-runtime': { provider: 'test', model: 'model' }, llm: { adapters: [{ providers: ['test'], adapter }] } }
  try {
    const parent = await createTestAgent(framework, { id: 'parent', presetId: 'character-agent', pluginConfigs: config })
    await parent.run({ prompt: '历史' })
    const snapshot = source(parent.context.agentLoop).snapshotForkHistory()
    const make = (initialSessionEvents: unknown, extra = {}) => createTestAgent(framework, { id: 'invalid', presetId: 'generic-subagent', pluginConfigs: {
      ...config, 'agent-loop-runtime': { provider: 'test', model: 'model', initialSessionEvents, ...extra },
    } })
    await assert.rejects(make(snapshot.slice(0, -1)), /未闭合/)
    const withTool = [...structuredClone(snapshot)]
    withTool.splice(2, 0, { type: 'tool/call', seq: 2, time: Date.now(), data: { turn: 1, step: 1, callId: 'tool' as ToolCallId, name: 'tool', arguments: '{}' } })
    const renumbered = withTool.map((event, seq) => ({ ...event, seq }))
    await assert.rejects(make(renumbered), /不支持的事件/)
    const withReplay = snapshot.map(event => event.type === 'assistant/message' ? { ...event, data: { ...event.data,
      message: { ...event.data.message, source: { ...event.data.message.source, replayState: { private: true } } },
    } } : event)
    await assert.rejects(make(withReplay), /重放状态/)
    await assert.rejects(make(snapshot, { sessionId: 'cannot-use' }), /不能与持久化/)
    await assert.rejects(make(snapshot, { resumeSessionId: 'cannot-use' }), /不能与持久化/)
    assert.deepEqual(framework.manager.list().map(agent => agent.info.identity.id), ['parent'])
  } finally { await framework.manager.disposeAll() }
})
