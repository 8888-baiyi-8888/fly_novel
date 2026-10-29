import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@fly-novel/llm'
import { bootstrapAgents, jsonlSessionPersistencePlugin } from '@fly-novel/agents'

class FixedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-end', index: 0, block: { type: 'text', text: `回答${this.requests.length}` } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

test('Agent Loop 新建和恢复 JSONL 会话，保留模型历史及轮次', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fly-loop-persistence-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const adapter = new FixedAdapter()
  const setup = async (resume: boolean) => {
    const framework = await bootstrapAgents()
    const backend = framework.context.plugin(jsonlSessionPersistencePlugin, { root: directory })
    await backend
    const agent = await framework.manager.create({ id: 'character', presetId: 'character-agent', pluginConfigs: {
      'agent-loop-runtime': { provider: 'test', model: 'test', ...(resume ? { resumeSessionId: 'session-1' } : { sessionId: 'session-1' }) },
      llm: { adapters: [{ providers: ['test'], adapter }] },
    } })
    return { framework, backend, agent }
  }
  const first = await setup(false)
  assert.equal(first.agent.context.sessions.list()[0]?.id, 'session-1')
  assert.deepEqual(await first.agent.run({ prompt: '第一次' }), { content: '回答1' })
  await first.framework.manager.disposeAll()
  await first.backend.dispose()
  const second = await setup(true)
  t.after(async () => { await second.framework.manager.disposeAll(); await second.backend.dispose() })
  assert.deepEqual(await second.agent.run({ prompt: '第二次' }), { content: '回答2' })
  const messages = adapter.requests[1]?.messages
  assert.ok(messages)
  assert.deepEqual(messages.map(message => message.role), ['system', 'user', 'assistant', 'user'])
  assert.deepEqual(messages[1]?.content, [{ type: 'text', text: '第一次' }])
  assert.deepEqual(messages[2]?.content, [{ type: 'text', text: '回答1' }])
  assert.deepEqual(messages[3]?.content, [{ type: 'text', text: '第二次' }])
  const events = second.agent.context.sessions.list()[0]?.read()
  assert.deepEqual(events?.filter(event => event.type === 'turn/start').map(event => event.data.turn), [1, 2])
})

test('持久化配置缺少后端、ID 冲突和不存在的会话均拒绝创建', async (t) => {
  const framework = await bootstrapAgents()
  t.after(() => framework.manager.disposeAll())
  const adapter = new FixedAdapter()
  const llm = { adapters: [{ providers: ['test'], adapter }] }
  const make = (config: Record<string, unknown>) => framework.manager.create({ id: 'invalid', presetId: 'character-agent',
    pluginConfigs: { 'agent-loop-runtime': { provider: 'test', model: 'test', ...config }, llm } })
  await assert.rejects(make({ sessionId: 's' }), /未配置 Session 持久化后端/)
  await assert.rejects(make({ sessionId: 's', resumeSessionId: 's' }), /不能同时指定/)
  const directory = await mkdtemp(join(tmpdir(), 'fly-loop-missing-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const backend = framework.context.plugin(jsonlSessionPersistencePlugin, { root: directory })
  await backend
  t.after(() => backend.dispose())
  await assert.rejects(make({ resumeSessionId: 'missing' }))
  const created = await make({ sessionId: 's' })
  await framework.manager.dispose(created.info.identity.id)
  await assert.rejects(make({ sessionId: 's' }), /已存在/)
})
