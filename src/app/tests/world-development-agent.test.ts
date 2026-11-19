import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { LlmAdapter, type GenerateOptions, type StreamChunk, type ToolCallId } from '@fly-novel/llm'
import { initializeCatalog } from '../../world-init/workspace/catalog/format.js'
import configured = require('../call-llm.js')
import { createWorldDevelopmentAgent } from '../agents/world-development-agent.js'
import { createWorldInitializationAgentWithWorldWorkspaces } from '../agents/index.js'

const dirs = ['macro-development/blueprints', 'macro-development/directions', 'macro-development/proposals', 'storylines/stories', 'storylines/growth-lines', 'character-growth/blueprints', 'character-growth/items', 'candidates']
class Script extends LlmAdapter {
  requests: GenerateOptions[] = []
  constructor(private readonly calls: { name: string; args: object }[] = []) { super() }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options); const call = this.calls[this.requests.length - 1]
    if (call) { yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `step-${this.requests.length}` as ToolCallId, name: call.name, arguments: JSON.stringify(call.args) } }; yield { type: 'finish', reason: { kind: 'tool-calls' } } }
    else { yield { type: 'block-end', index: 0, block: { type: 'text', text: '规划已处理' } }; yield { type: 'finish', reason: { kind: 'stop' } } }
  }
}
async function setup(t: TestContext) {
  const tmp = join(process.cwd(), 'tmp'); await mkdir(tmp, { recursive: true }); const root = await realpath(await mkdtemp(join(tmp, 'development-agent-'))); t.after(() => rm(root, { recursive: true, force: true }))
  const readRoot = join(root, 'world'); const sessionRoot = join(root, 'sessions')
  for (const name of ['main', 'confirmed', 'catalog', ...dirs.map(dir => `development/${dir}`)]) await mkdir(join(readRoot, name), { recursive: true }); await mkdir(sessionRoot)
  const world = { worldId: 'development-world', readRoot, confirmedRoot: join(readRoot, 'confirmed'), catalogRoot: join(readRoot, 'catalog'), mainAgent: { agentId: 'main', writableRoot: join(readRoot, 'main') }, agents: [{ agentId: 'development', writableRoot: join(readRoot, 'development') }] }
  return { world, sessionRoot }
}
const content = { name: '河谷规划', summary: '', body: '', reserved: [], applicability: { kind: 'unknown' }, references: [], links: [], person: null }
test('独立规划 Agent 创建成果并恢复会话', async t => {
  const { world, sessionRoot } = await setup(t); const adapter = new Script([{ name: 'world_development_create', args: { kind: 'macro-blueprint', content } }])
  const config = { workspaces: [world], worldId: world.worldId, agentId: 'development', sessionId: 's', sessionRoot, sessionMode: 'create' as const, provider: 'test', model: 'test', adapter, singleWriterProcess: true as const }
  const agent = await createWorldDevelopmentAgent(config); await assert.rejects(createWorldDevelopmentAgent(config), /占用|使用/)
  try { assert.deepEqual(await agent.run({ prompt: '规划河谷' }), { content: '规划已处理' }) } finally { await agent.dispose() }
  assert.equal((await readdir(join(world.readRoot, 'development/macro-development/blueprints'))).length, 1)
  const resumedAdapter = new Script(); const resumed = await createWorldDevelopmentAgent({ ...config, sessionMode: 'resume', adapter: resumedAdapter })
  try { await resumed.run({ prompt: '继续' }); assert.match(JSON.stringify(resumedAdapter.requests[0]?.messages), /规划河谷/) } finally { await resumed.dispose() }
})
test('主 Agent 委派规划 Agent，主 Agent 不持有规划写工具', async t => {
  const { world, sessionRoot } = await setup(t); await initializeCatalog(world.catalogRoot, world.worldId)
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'test', adapter: new Script() }))
  const child = new Script([{ name: 'world_development_create', args: { kind: 'storyline', content } }])
  const parent = await createWorldInitializationAgentWithWorldWorkspaces([world], world.worldId, undefined, { singleWriterProcess: true, catalog: {}, worldDevelopmentAgent: { agentId: 'development', sessionId: 's', sessionRoot, sessionMode: 'create', provider: 'test', model: 'test', adapter: child } })
  try {
    assert.ok(parent.context.tools.get('delegate_world_development')); assert.equal(parent.context.tools.get('world_development_create'), undefined)
    assert.match(String(parent.context.systemPrompt.getSection('world-initialization:world-development-agent')?.text), /delegate_world_development/)
    const result = await parent.context.tools.execute({ calls: [{ type: 'tool-call', id: 'delegate' as ToolCallId, name: 'delegate_world_development', arguments: JSON.stringify({ task: '规划故事线' }) }], workingDirectory: world.readRoot, session: parent.context.sessions.list()[0]!, signal: new AbortController().signal })
    assert.equal(result.results[0]?.result.isError, false); assert.equal((await readdir(join(world.readRoot, 'development/storylines/stories'))).length, 1)
  } finally { await parent.dispose() }
})
test('世界发展规划和初始局势专用 Agent 可以同时装配并各写所属目录', async t => {
  const { world, sessionRoot } = await setup(t)
  for (const name of ['overviews', 'situations', 'candidates']) await mkdir(join(world.readRoot, 'situation', name), { recursive: true })
  world.agents.push({ agentId: 'situation', writableRoot: join(world.readRoot, 'situation') })
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'test', adapter: new Script() }))
  const parent = await createWorldInitializationAgentWithWorldWorkspaces([world], world.worldId, undefined, { singleWriterProcess: true,
    initialSituationAgent: { agentId: 'situation', sessionId: 's', sessionRoot, sessionMode: 'create', provider: 'test', model: 'test', adapter: new Script([{ name: 'situation_start_create', args: { description: '起点' } }]) },
    worldDevelopmentAgent: { agentId: 'development', sessionId: 's', sessionRoot, sessionMode: 'create', provider: 'test', model: 'test', adapter: new Script([{ name: 'world_development_create', args: { kind: 'growth-blueprint', content } }]) } })
  try {
    for (const name of ['delegate_initial_situation', 'delegate_world_development']) {
      assert.ok(parent.context.tools.get(name))
      const result = await parent.context.tools.execute({ calls: [{ type: 'tool-call', id: name as ToolCallId, name, arguments: JSON.stringify({ task: '建立规划' }) }], workingDirectory: world.readRoot, session: parent.context.sessions.list()[0]!, signal: new AbortController().signal })
      assert.equal(result.results[0]?.result.isError, false)
    }
    assert.equal((await readdir(join(world.readRoot, 'development/character-growth/blueprints'))).length, 1)
    assert.ok((await readdir(join(world.readRoot, 'situation'))).includes('start.json'))
  } finally { await parent.dispose() }
})
test('启动失败及关闭主 Agent 后释放规划身份', { timeout: 10000 }, async t => {
  const { world, sessionRoot } = await setup(t); const candidate = join(world.readRoot, 'development/candidates'); await rm(candidate, { recursive: true })
  const config = { agentId: 'development', sessionId: 'cancel', sessionMode: 'create' as const, sessionRoot, provider: 'test', model: 'test', adapter: new Script() }
  await assert.rejects(createWorldDevelopmentAgent({ ...config, workspaces: [world], worldId: world.worldId, singleWriterProcess: true })); await mkdir(candidate)
  class Parent extends LlmAdapter { override async *stream(): AsyncIterable<StreamChunk> { yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'delegate' as ToolCallId, name: 'delegate_world_development', arguments: JSON.stringify({ task: '规划' }) } }; yield { type: 'finish', reason: { kind: 'tool-calls' } } } }
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'test', adapter: new Parent() }))
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve })
  class Wait extends LlmAdapter { override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> { entered(); if (!options.signal?.aborted) await new Promise<void>(resolve => options.signal?.addEventListener('abort', () => resolve(), { once: true })); yield { type: 'finish', reason: { kind: 'aborted', failure: { message: '取消', code: 'ABORTED' } } } } }
  const parent = await createWorldInitializationAgentWithWorldWorkspaces([world], world.worldId, undefined, { singleWriterProcess: true, worldDevelopmentAgent: { ...config, adapter: new Wait() } })
  const pending = parent.run({ prompt: '规划' }); const rejected = assert.rejects(pending); await started; await parent.dispose(); await rejected
  const resumed = await createWorldDevelopmentAgent({ ...config, sessionMode: 'resume', workspaces: [world], worldId: world.worldId, singleWriterProcess: true }); await resumed.dispose()
})
