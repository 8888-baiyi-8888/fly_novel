import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { LlmAdapter, type GenerateOptions, type StreamChunk, type ToolCallId } from '@fly-novel/llm'
import { initializeCatalog } from '../../world-init/workspace/catalog/format.js'
import configured = require('../call-llm.js')
import { createWorldSpecificAgent } from '../agents/world-specific-agent.js'
import { createWorldInitializationAgentWithWorldWorkspaces } from '../agents/index.js'

class Script extends LlmAdapter {
  requests: GenerateOptions[] = []
  constructor(private readonly calls: { name: string; args: object }[] = []) { super() }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options); const call = this.calls[this.requests.length - 1]
    if (call) { yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `step-${this.requests.length}` as ToolCallId, name: call.name, arguments: JSON.stringify(call.args) } }; yield { type: 'finish', reason: { kind: 'tool-calls' } } }
    else { yield { type: 'block-end', index: 0, block: { type: 'text', text: '专有内容已处理' } }; yield { type: 'finish', reason: { kind: 'stop' } } }
  }
}
async function setup(t: TestContext) {
  const tmp = join(process.cwd(), 'tmp'); await mkdir(tmp, { recursive: true }); const root = await realpath(await mkdtemp(join(tmp, 'specific-agent-'))); t.after(() => rm(root, { recursive: true, force: true }))
  const readRoot = join(root, 'world'); const sessionRoot = join(root, 'sessions'); for (const name of ['main', 'confirmed', 'catalog', 'specific/topics', 'specific/items', 'specific/candidates']) await mkdir(join(readRoot, name), { recursive: true }); await mkdir(sessionRoot)
  const world = { worldId: 'specific-world', readRoot, confirmedRoot: join(readRoot, 'confirmed'), catalogRoot: join(readRoot, 'catalog'), mainAgent: { agentId: 'main', writableRoot: join(readRoot, 'main') }, agents: [{ agentId: 'specific', writableRoot: join(readRoot, 'specific') }] }
  return { world, sessionRoot }
}
const content = { name: '修炼体系', aliases: [], detailLevel: 'overview', summary: '', body: '', reserved: [], topicIds: [], links: [], references: [] }
test('独立专有 Agent 创建主题，重建后恢复会话', async t => {
  const { world, sessionRoot } = await setup(t); const adapter = new Script([{ name: 'world_specific_topic_create', args: { content } }])
  const config = { workspaces: [world], worldId: world.worldId, agentId: 'specific', sessionId: 's', sessionRoot, sessionMode: 'create' as const, provider: 'test', model: 'test', adapter, singleWriterProcess: true as const }
  const agent = await createWorldSpecificAgent(config); await assert.rejects(createWorldSpecificAgent(config), /占用|使用/)
  try { assert.deepEqual(await agent.run({ prompt: '补充专有设定' }), { content: '专有内容已处理' }) } finally { await agent.dispose() }
  assert.equal((await readdir(join(world.readRoot, 'specific/topics'))).length, 1)
  const resumedAdapter = new Script(); const resumed = await createWorldSpecificAgent({ ...config, sessionMode: 'resume', adapter: resumedAdapter })
  try { await resumed.run({ prompt: '继续' }); assert.match(JSON.stringify(resumedAdapter.requests[0]?.messages), /补充专有设定/) } finally { await resumed.dispose() }
})
test('主 Agent 委派专有 Agent，主 Agent 不持有专有写工具', async t => {
  const { world, sessionRoot } = await setup(t); await initializeCatalog(world.catalogRoot, world.worldId)
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'test', adapter: new Script() }))
  const child = new Script([{ name: 'world_specific_topic_create', args: { content } }])
  const parent = await createWorldInitializationAgentWithWorldWorkspaces([world], world.worldId, undefined, { singleWriterProcess: true, catalog: {}, worldSpecificAgent: { agentId: 'specific', sessionId: 's', sessionRoot, sessionMode: 'create', provider: 'test', model: 'test', adapter: child } })
  try {
    assert.ok(parent.context.tools.get('delegate_world_specific')); assert.equal(parent.context.tools.get('world_specific_topic_create'), undefined)
    assert.match(String(parent.context.systemPrompt.getSection('world-initialization:world-specific-agent')?.text), /delegate_world_specific/)
    const response = await parent.context.tools.execute({ calls: [{ type: 'tool-call', id: 'delegate' as ToolCallId, name: 'delegate_world_specific', arguments: JSON.stringify({ task: '自主完善世界设定' }) }], workingDirectory: world.readRoot, session: parent.context.sessions.list()[0]!, signal: new AbortController().signal })
    assert.equal(response.results[0]?.result.isError, false); assert.equal((await readdir(join(world.readRoot, 'specific/topics'))).length, 1)
  } finally { await parent.dispose() }
})
test('专有内容和世界发展规划 Agent 可同时装配，各写所属目录', async t => {
  const { world, sessionRoot } = await setup(t)
  for (const name of ['macro-development/blueprints', 'macro-development/directions', 'macro-development/proposals', 'storylines/stories', 'storylines/growth-lines', 'character-growth/blueprints', 'character-growth/items', 'candidates']) await mkdir(join(world.readRoot, 'development', name), { recursive: true })
  world.agents.push({ agentId: 'development', writableRoot: join(world.readRoot, 'development') })
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'test', adapter: new Script() }))
  const planning = { name: '世界方向', summary: '', body: '', reserved: [], applicability: { kind: 'unknown' }, references: [], links: [], person: null }
  const parent = await createWorldInitializationAgentWithWorldWorkspaces([world], world.worldId, undefined, { singleWriterProcess: true,
    worldDevelopmentAgent: { agentId: 'development', sessionId: 's', sessionRoot, sessionMode: 'create', provider: 'test', model: 'test', adapter: new Script([{ name: 'world_development_create', args: { kind: 'macro-blueprint', content: planning } }]) },
    worldSpecificAgent: { agentId: 'specific', sessionId: 's', sessionRoot, sessionMode: 'create', provider: 'test', model: 'test', adapter: new Script([{ name: 'world_specific_topic_create', args: { content } }]) } })
  try {
    for (const name of ['delegate_world_development', 'delegate_world_specific']) {
      assert.ok(parent.context.tools.get(name)); const result = await parent.context.tools.execute({ calls: [{ type: 'tool-call', id: name as ToolCallId, name, arguments: JSON.stringify({ task: '按需规划' }) }], workingDirectory: world.readRoot, session: parent.context.sessions.list()[0]!, signal: new AbortController().signal }); assert.equal(result.results[0]?.result.isError, false)
    }
    assert.equal((await readdir(join(world.readRoot, 'specific/topics'))).length, 1); assert.equal((await readdir(join(world.readRoot, 'development/macro-development/blueprints'))).length, 1)
  } finally { await parent.dispose() }
})
test('启动失败及取消后释放专有 Agent 身份', { timeout: 10000 }, async t => {
  const { world, sessionRoot } = await setup(t); const candidate = join(world.readRoot, 'specific/candidates'); await rm(candidate, { recursive: true })
  const config = { agentId: 'specific', sessionId: 'cancel', sessionMode: 'create' as const, sessionRoot, provider: 'test', model: 'test', adapter: new Script() }
  await assert.rejects(createWorldSpecificAgent({ ...config, workspaces: [world], worldId: world.worldId, singleWriterProcess: true })); await mkdir(candidate)
  class Parent extends LlmAdapter { override async *stream(): AsyncIterable<StreamChunk> { yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'delegate' as ToolCallId, name: 'delegate_world_specific', arguments: JSON.stringify({ task: '规划' }) } }; yield { type: 'finish', reason: { kind: 'tool-calls' } } } }
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'test', adapter: new Parent() }))
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve })
  class Wait extends LlmAdapter { override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> { entered(); if (!options.signal?.aborted) await new Promise<void>(resolve => options.signal?.addEventListener('abort', () => resolve(), { once: true })); yield { type: 'finish', reason: { kind: 'aborted', failure: { message: '取消', code: 'ABORTED' } } } } }
  const parent = await createWorldInitializationAgentWithWorldWorkspaces([world], world.worldId, undefined, { singleWriterProcess: true, worldSpecificAgent: { ...config, adapter: new Wait() } })
  const pending = parent.run({ prompt: '规划' }); const rejected = assert.rejects(pending); await started; await parent.dispose(); await rejected
  const resumed = await createWorldSpecificAgent({ ...config, sessionMode: 'resume', workspaces: [world], worldId: world.worldId, singleWriterProcess: true }); await resumed.dispose()
})
