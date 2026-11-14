import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { LlmAdapter, type GenerateOptions, type StreamChunk, type ToolCallId } from '@fly-novel/llm'
import configured = require('../call-llm.js')
import { createMapAgent, createWorldInitializationAgentWithWorldWorkspaces } from '../agents/index.js'
import { initializeCatalog } from '../../world-init/workspace/catalog/format.js'

class ScriptAdapter extends LlmAdapter {
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
    } else {
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '地图资料已处理' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

async function setup(t: TestContext) {
  const temp = join(process.cwd(), 'tmp'); await mkdir(temp, { recursive: true })
  const root = await realpath(await mkdtemp(join(temp, 'map-agent-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const readRoot = join(root, 'world'); const sessionRoot = join(root, 'sessions')
  for (const name of ['main', 'map/places', 'map/connections', 'basics', 'characters', 'catalog', 'confirmed']) await mkdir(join(readRoot, name), { recursive: true })
  await mkdir(sessionRoot)
  const world = { worldId: 'map-world', readRoot, confirmedRoot: join(readRoot, 'confirmed'), catalogRoot: join(readRoot, 'catalog'),
    mainAgent: { agentId: 'main', writableRoot: join(readRoot, 'main') }, agents: [
      { agentId: 'map', writableRoot: join(readRoot, 'map') }, { agentId: 'basics', writableRoot: join(readRoot, 'basics') }, { agentId: 'creator', writableRoot: join(readRoot, 'characters') },
    ] }
  return { root, world, sessionRoot }
}

const overview = { name: '河谷', description: '城邦群', scale: { width: 1000, height: 600, unit: 'km' }, layers: [{ id: 'city', name: '城邦' }], orientation: '上为北', reserved: ['外海'] }
const place = { name: '青河', aliases: [], description: '河谷城邦', detailLevel: 'overview', reserved: [], parents: [
  { layerId: 'city', parent: { kind: 'world' }, localBoxes: [[100, 100, 300, 300]], frameBox: [100, 100, 300, 300], coverage: 'complete' },
] }
const calls = [
  { name: 'map_overview_create', args: overview }, { name: 'map_place_create', args: place },
  { name: 'catalog_register', args: { path: 'map/map.json', summary: '世界地图概览' } },
]

test('独立地图 Agent 使用地图工具、资料目录和可恢复会话', async t => {
  const { world, sessionRoot } = await setup(t)
  await initializeCatalog(world.catalogRoot, world.worldId)
  const adapter = new ScriptAdapter(calls)
  const config = { workspaces: [world], worldId: world.worldId, agentId: 'map', sessionId: 'session', sessionMode: 'create' as const,
    sessionRoot, provider: 'test', model: 'test', adapter, singleWriterProcess: true as const, catalog: {} }
  const agent = await createMapAgent(config)
  await assert.rejects(createMapAgent(config), /占用|使用/)
  try {
    assert.deepEqual(await agent.run({ prompt: '规划近期城邦地图' }), { content: '地图资料已处理' })
    assert.match(await readFile(join(world.readRoot, 'map', 'map.json'), 'utf8'), /河谷/)
    assert.match(await readFile(join(world.catalogRoot, 'catalog.json'), 'utf8'), /世界地图概览/)
    assert.match(JSON.stringify(adapter.requests[0].messages), /localBoxes/)
  } finally { await agent.dispose() }
  const resumedAdapter = new ScriptAdapter()
  const resumed = await createMapAgent({ ...config, adapter: resumedAdapter, sessionMode: 'resume' })
  try { await resumed.run({ prompt: '继续' }); assert.match(JSON.stringify(resumedAdapter.requests[0].messages), /规划近期城邦地图/) }
  finally { await resumed.dispose() }
})

test('主 Agent 同时装配地图、角色和基础信息委派，地图共享目录并隔离身份', async t => {
  const { world, sessionRoot } = await setup(t)
  await initializeCatalog(world.catalogRoot, world.worldId)
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'test', adapter: new ScriptAdapter() }))
  const common = { sessionRoot, sessionMode: 'create' as const, provider: 'test', model: 'test' }
  const creator = { ...common, agentId: 'creator', sessionId: 'creator', adapter: new ScriptAdapter(), initializeCharacters: true, defaultCharacterCount: 1 }
  const basics = { ...common, agentId: 'basics', sessionId: 'basics', adapter: new ScriptAdapter() }
  const mapAdapter = new ScriptAdapter(calls)
  const map = { ...common, agentId: 'map', sessionId: 'map', adapter: mapAdapter }
  const parent = await createWorldInitializationAgentWithWorldWorkspaces([world], world.worldId, creator, { singleWriterProcess: true, catalog: {}, worldBasics: basics, mapAgent: map })
  try {
    assert.ok(parent.context.tools.get('delegate_map')); assert.ok(parent.context.tools.get('delegate_world_basics')); assert.ok(parent.context.tools.get('delegate_character_creator'))
    assert.equal(parent.context.tools.get('map_place_create'), undefined)
    assert.match(String(parent.context.systemPrompt.getSection('world-initialization:map-agent')?.text), /delegate_map/)
    assert.match(String(parent.context.systemPrompt.getSection('world-initialization:catalog-alignment')?.text), /delegate_map/)
    const call = async (args: object, name = 'delegate_map') => (await parent.context.tools.execute({ calls: [{ type: 'tool-call', id: 'call' as ToolCallId, name, arguments: JSON.stringify(args) }],
      workingDirectory: world.readRoot, session: parent.context.sessions.list()[0]!, signal: new AbortController().signal })).results[0].result
    assert.equal((await call({ task: '规划城邦群' })).isError, false)
    assert.match(await readFile(join(world.readRoot, 'map', 'map.json'), 'utf8'), /河谷/)
    assert.match(await readFile(join(world.catalogRoot, 'catalog.json'), 'utf8'), /世界地图概览/)
    assert.equal((await call({ task: '继续' })).isError, false)
    assert.match(JSON.stringify(mapAdapter.requests.at(-1)?.messages), /规划城邦群/)
    assert.equal((await call({ task: '核对基础资料' }, 'delegate_world_basics')).isError, false)
    assert.equal((await call({ task: '核对角色需求' }, 'delegate_character_creator')).isError, false)
    assert.equal((await call({ task: '伪造', worldId: 'other' })).isError, true)
  } finally { await parent.dispose() }
  const agent = await createMapAgent({ ...map, workspaces: [world], worldId: world.worldId, singleWriterProcess: true, sessionMode: 'resume' })
  await agent.dispose()
})

test('未配置不暴露地图委派，关闭父 Agent 时取消任务并释放地图身份', { timeout: 10000 }, async t => {
  const { world, sessionRoot } = await setup(t)
  class ParentAdapter extends LlmAdapter {
    override async *stream(): AsyncIterable<StreamChunk> {
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'delegate' as ToolCallId, name: 'delegate_map', arguments: JSON.stringify({ task: '规划世界地图' }) } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
  }
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'test', adapter: new ParentAdapter() }))
  const noMap = await createWorldInitializationAgentWithWorldWorkspaces([world], world.worldId, undefined, { singleWriterProcess: true })
  assert.equal(noMap.context.tools.get('delegate_map'), undefined)
  await noMap.dispose()
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  class WaitAdapter extends LlmAdapter {
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      entered()
      if (!options.signal?.aborted) await new Promise<void>(resolve => options.signal?.addEventListener('abort', () => resolve(), { once: true }))
      yield { type: 'finish', reason: { kind: 'aborted', failure: { message: '取消', code: 'ABORTED' } } }
    }
  }
  const map = { agentId: 'map', sessionId: 'cancel', sessionMode: 'create' as const, sessionRoot, provider: 'test', model: 'test', adapter: new WaitAdapter() }
  const parent = await createWorldInitializationAgentWithWorldWorkspaces([world], world.worldId, undefined, { singleWriterProcess: true, mapAgent: map })
  const pending = parent.run({ prompt: '规划' }); const rejected = assert.rejects(pending)
  await started; await parent.dispose(); await rejected
  const resumed = await createMapAgent({ ...map, adapter: new ScriptAdapter(), sessionMode: 'resume', workspaces: [world], worldId: world.worldId, singleWriterProcess: true })
  await resumed.dispose()
})

test('地图目录缺失或身份冲突时拒绝装配，不占用 Agent 身份', async t => {
  const { world, sessionRoot } = await setup(t)
  const base = { agentId: 'map', sessionId: 's', sessionMode: 'create' as const, sessionRoot, provider: 'test', model: 'test', adapter: new ScriptAdapter() }
  await assert.rejects(createWorldInitializationAgentWithWorldWorkspaces([world], world.worldId, undefined,
    { singleWriterProcess: true, worldBasics: base, mapAgent: base }), /身份不能相同/)
  await rm(join(world.readRoot, 'map', 'connections'), { recursive: true })
  await assert.rejects(createMapAgent({ ...base, workspaces: [world], worldId: world.worldId, singleWriterProcess: true }))
  await mkdir(join(world.readRoot, 'map', 'connections'))
  const agent = await createMapAgent({ ...base, workspaces: [world], worldId: world.worldId, singleWriterProcess: true })
  await agent.dispose()
})

test('资料目录不可用时地图 Agent 拒绝启动，修复配置后可启动', async t => {
  const { world, sessionRoot } = await setup(t)
  const config = { workspaces: [world], worldId: world.worldId, agentId: 'map', sessionId: 'catalog', sessionMode: 'create' as const,
    sessionRoot, provider: 'test', model: 'test', adapter: new ScriptAdapter(), singleWriterProcess: true as const, catalog: {} }
  await assert.rejects(createMapAgent(config))
  await initializeCatalog(world.catalogRoot, world.worldId)
  const agent = await createMapAgent(config)
  await agent.dispose()
})
