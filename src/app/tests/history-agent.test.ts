import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { LlmAdapter, type GenerateOptions, type StreamChunk, type ToolCallId } from '@fly-novel/llm'
import { initializeCatalog } from '../../world-init/workspace/catalog/format.js'
import { createHistoryAgent, createWorldInitializationAgentWithWorldWorkspaces } from '../agents/index.js'
import configured = require('../call-llm.js')

class Script extends LlmAdapter {
  requests: GenerateOptions[] = []
  constructor(private readonly calls: { name: string; args: object }[] = []) { super() }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.requests.length > 1 && this.requests.length <= this.calls.length + 1) {
      const previous = options.messages.flatMap(message => message.content).find(block => block.type === 'tool-result' && block.toolCallId === `step-${this.requests.length - 1}`)
      assert.ok(previous && previous.type === 'tool-result' && !previous.isError, JSON.stringify(previous))
    }
    const call = this.calls[this.requests.length - 1]
    if (call) {
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `step-${this.requests.length}` as ToolCallId, name: call.name, arguments: JSON.stringify(call.args) } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else { yield { type: 'block-end', index: 0, block: { type: 'text', text: '历史资料已处理' } }; yield { type: 'finish', reason: { kind: 'stop' } } }
  }
}
async function setup(t: TestContext) {
  const tmp = join(process.cwd(), 'tmp'); await mkdir(tmp, { recursive: true })
  const root = await realpath(await mkdtemp(join(tmp, 'history-agent-'))); t.after(() => rm(root, { recursive: true, force: true }))
  const readRoot = join(root, 'world'); const sessionRoot = join(root, 'sessions')
  for (const name of ['main', 'history/events', 'history/candidates', 'characters', 'map', 'organization', 'confirmed', 'catalog']) await mkdir(join(readRoot, name), { recursive: true })
  await mkdir(sessionRoot)
  const world = { worldId: 'history-world', readRoot, confirmedRoot: join(readRoot, 'confirmed'), catalogRoot: join(readRoot, 'catalog'),
    mainAgent: { agentId: 'main', writableRoot: join(readRoot, 'main') }, agents: [
      { agentId: 'history', writableRoot: join(readRoot, 'history') }, { agentId: 'characters', writableRoot: join(readRoot, 'characters') },
      { agentId: 'map', writableRoot: join(readRoot, 'map') }, { agentId: 'organization', writableRoot: join(readRoot, 'organization') }] }
  return { root, world, sessionRoot }
}
const content = { name: '旧战争', aliases: [], detailLevel: 'overview', summary: '约三百年前', body: '', time: [], parents: [], childrenCoverage: 'unknown',
  relations: [], references: [{ kind: 'unresolved', type: 'person', description: '未建档参与者' }], publicAccounts: [], hidden: { state: 'unknown', note: '' }, reserved: [] }

test('独立历史 Agent 创建事件，重建后恢复会话并保留事件', async t => {
  const { world, sessionRoot } = await setup(t); const adapter = new Script([{ name: 'history_event_create', args: { content } }])
  const config = { workspaces: [world], worldId: world.worldId, agentId: 'history', sessionId: 's', sessionRoot, sessionMode: 'create' as const, provider: 'test', model: 'test', adapter, singleWriterProcess: true as const }
  const agent = await createHistoryAgent(config)
  await assert.rejects(createHistoryAgent(config), /占用|使用/)
  try { assert.deepEqual(await agent.run({ prompt: '创建旧战争' }), { content: '历史资料已处理' }) } finally { await agent.dispose() }
  const resumedAdapter = new Script([{ name: 'history_event_search', args: { keyword: '旧战争' } }])
  const resumed = await createHistoryAgent({ ...config, sessionMode: 'resume', adapter: resumedAdapter })
  try { await resumed.run({ prompt: '继续' }); assert.match(JSON.stringify(resumedAdapter.requests[0]?.messages), /创建旧战争/) } finally { await resumed.dispose() }
})

test('主 Agent 可委派历史 Agent 创建成果', async t => {
  const { world, sessionRoot } = await setup(t); await initializeCatalog(world.catalogRoot, world.worldId)
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'test', adapter: new Script() }))
  const child = new Script([{ name: 'history_event_create', args: { content } }])
  const parent = await createWorldInitializationAgentWithWorldWorkspaces([world], world.worldId, undefined, { singleWriterProcess: true, catalog: {},
    historyAgent: { agentId: 'history', sessionId: 's', sessionRoot, sessionMode: 'create', provider: 'test', model: 'test', adapter: child } })
  try {
    assert.ok(parent.context.tools.get('delegate_history')); assert.equal(parent.context.tools.get('history_event_create'), undefined)
    assert.match(String(parent.context.systemPrompt.getSection('world-initialization:history-agent')?.text), /delegate_history/)
    const result = await parent.context.tools.execute({ calls: [{ type: 'tool-call', id: 'delegate' as ToolCallId, name: 'delegate_history', arguments: JSON.stringify({ task: '创建历史' }) }],
      workingDirectory: world.readRoot, session: parent.context.sessions.list()[0]!, signal: new AbortController().signal })
    assert.equal(result.results[0]?.result.isError, false)
    assert.match(JSON.stringify(child.requests), /history_event_create/)
  } finally { await parent.dispose() }
})

test('缺失历史目录启动失败后释放身份，修复后可以启动', async t => {
  const { world, sessionRoot } = await setup(t); await rm(join(world.readRoot, 'history', 'candidates'), { recursive: true })
  const config = { workspaces: [world], worldId: world.worldId, agentId: 'history', sessionId: 's', sessionRoot, sessionMode: 'create' as const, provider: 'test', model: 'test', adapter: new Script(), singleWriterProcess: true as const }
  await assert.rejects(createHistoryAgent(config)); await mkdir(join(world.readRoot, 'history', 'candidates'))
  const agent = await createHistoryAgent(config); await agent.dispose()
})

test('关闭主 Agent 取消历史任务并释放身份', { timeout: 10000 }, async t => {
  const { world, sessionRoot } = await setup(t)
  class ParentAdapter extends LlmAdapter {
    override async *stream(): AsyncIterable<StreamChunk> {
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'delegate' as ToolCallId, name: 'delegate_history', arguments: JSON.stringify({ task: '规划历史' }) } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
  }
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'test', adapter: new ParentAdapter() }))
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  class WaitAdapter extends LlmAdapter {
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      entered()
      if (!options.signal?.aborted) await new Promise<void>(resolve => options.signal?.addEventListener('abort', () => resolve(), { once: true }))
      yield { type: 'finish', reason: { kind: 'aborted', failure: { message: '取消', code: 'ABORTED' } } }
    }
  }
  const history = { agentId: 'history', sessionId: 'cancel', sessionMode: 'create' as const, sessionRoot, provider: 'test', model: 'test', adapter: new WaitAdapter() }
  const parent = await createWorldInitializationAgentWithWorldWorkspaces([world], world.worldId, undefined, { singleWriterProcess: true, historyAgent: history })
  const pending = parent.run({ prompt: '规划' }); const rejected = assert.rejects(pending)
  await started; await parent.dispose(); await rejected
  const resumed = await createHistoryAgent({ ...history, adapter: new Script(), sessionMode: 'resume', workspaces: [world], worldId: world.worldId, singleWriterProcess: true })
  await resumed.dispose()
})
