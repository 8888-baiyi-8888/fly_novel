import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { LlmAdapter, type GenerateOptions, type StreamChunk, type ToolCallId } from '@fly-novel/llm'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@fly-novel/fs-local'
import { MapStore } from '@fly-novel/map'
import configured = require('../call-llm.js')
import { createMapAgent, createWorldInitializationAgentWithWorldWorkspaces } from '../agents/index.js'
import { initializeCatalog } from '../../world-init/workspace/catalog/format.js'
import { SharedMapStorage } from '../../world-init/storage/map.js'
import { createMapAgentWithCatalogBinding } from '../agents/map-agent.js'

class ScriptAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []
  constructor(private readonly calls: { name: string; args: object }[] = []) { super() }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.requests.length > 1 && this.requests.length <= this.calls.length + 1 && this.calls[this.requests.length - 2]?.name !== 'unused') {
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

test('外部引用持有地图存储时地图 Agent 不能重复打开，释放后可启动', async t => {
  const { world, sessionRoot } = await setup(t)
  const context = new Context()
  const backend = await context.plugin(LocalFileSystem, { cwd: world.readRoot })
  const store = await MapStore.open({ fs: context.fs, root: join(world.readRoot, 'map'), worldId: world.worldId, access: 'read-write', singleWriterProcess: true })
  const config = { workspaces: [world], worldId: world.worldId, agentId: 'map', sessionId: 'shared', sessionMode: 'create' as const,
    sessionRoot, provider: 'test', model: 'test', adapter: new ScriptAdapter(), singleWriterProcess: true as const }
  try {
    await assert.rejects(createMapAgent(config), /占用|使用/)
  } finally {
    await store.close()
    await backend.dispose()
  }
  const agent = await createMapAgent(config)
  await agent.dispose()
})

test('地图存储不同访问模式均独占同一世界和目录', async t => {
  const { world } = await setup(t)
  const context = new Context()
  const backend = await context.plugin(LocalFileSystem, { cwd: world.readRoot })
  const config = { fs: context.fs, root: join(world.readRoot, 'map'), worldId: world.worldId, singleWriterProcess: true as const }
  try {
    for (const first of ['read-only', 'read-write'] as const) {
      const store = await MapStore.open({ ...config, access: first })
      try {
        for (const second of ['read-only', 'read-write'] as const) {
          await assert.rejects(MapStore.open({ ...config, access: second }), { code: 'MAP_BUSY' })
        }
      } finally { await store.close() }
    }
  } finally { await backend.dispose() }
})

test('共享地图可并发借用，地图 Agent 退出后仍可读取', async t => {
  const { world, sessionRoot } = await setup(t)
  const shared = new SharedMapStorage(world, 'map')
  const [first, second] = await Promise.all([shared.get(), shared.get()])
  assert.equal(first, second)
  const config = { workspaces: [world], worldId: world.worldId, agentId: 'map', sessionId: 'borrowed', sessionMode: 'create' as const,
    sessionRoot, provider: 'test', model: 'test', adapter: new ScriptAdapter([{ name: 'map_overview_create', args: overview }]), singleWriterProcess: true as const }
  try {
    const agent = await createMapAgentWithCatalogBinding(config, undefined, first)
    try { await agent.run({ prompt: '规划地图' }) } finally { await agent.dispose() }
    assert.equal((await second.readOverview()).document.name, '河谷')
  } finally { await shared.close() }
  await assert.rejects(shared.get(), /关闭/)
})

test('主 Agent 委派地图、组织和人物时共用地图并只暴露查询工具', async t => {
  const { world, sessionRoot } = await setup(t)
  for (const name of ['organizations', 'relations', 'memberships']) await mkdir(join(world.readRoot, 'organization', name), { recursive: true })
  const configuredWorld = { ...world, agents: [...world.agents, { agentId: 'organization', writableRoot: join(world.readRoot, 'organization') }] }
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'test', adapter: new ScriptAdapter() }))
  const common = { sessionRoot, sessionMode: 'create' as const, provider: 'test', model: 'test' }
  const characterCalls: { name: string; args: object }[] = []; const organizationCalls: { name: string; args: object }[] = []
  const characterAdapter = new ScriptAdapter(characterCalls); const organizationAdapter = new ScriptAdapter(organizationCalls)
  const mapCalls: { name: string; args: object }[] = [{ name: 'map_overview_create', args: overview }, { name: 'map_place_create', args: place }]
  const parent = await createWorldInitializationAgentWithWorldWorkspaces([configuredWorld], world.worldId,
    { ...common, agentId: 'creator', sessionId: 'creator', adapter: characterAdapter, initializeCharacters: true, defaultCharacterCount: 1 },
    { singleWriterProcess: true, mapAgent: { ...common, agentId: 'map', sessionId: 'map', adapter: new ScriptAdapter(mapCalls) },
      organizationAgent: { ...common, agentId: 'organization', sessionId: 'organization', adapter: organizationAdapter } })
  try {
    const call = async (name: string) => (await parent.context.tools.execute({ calls: [{ type: 'tool-call', id: name as ToolCallId, name, arguments: JSON.stringify({ task: '核对资料' }) }],
      workingDirectory: world.readRoot, session: parent.context.sessions.list()[0]!, signal: new AbortController().signal })).results[0].result
    assert.equal((await call('delegate_map')).isError, false)
    const [placeFile] = await readdir(join(world.readRoot, 'map', 'places'))
    assert.ok(placeFile)
    const placeId = placeFile.replace(/\.json$/, '')
    organizationCalls.push({ name: 'organization_reference_check', args: { kind: 'place', id: placeId } })
    organizationCalls.push({ name: 'organization_create', args: { content: { name: '青河议会', aliases: [], organizationType: '城邦', detailLevel: 'overview', minLevel: 0,
      sections: [{ title: '概况', content: '城邦议事组织', minLevel: 0 }], locations: [], reserved: [] } } })
    characterCalls.push({ name: 'map_place_read', args: { id: placeId } })
    const results = await Promise.all([call('delegate_organization'), call('delegate_character_creator')])
    assert.ok(results.every(value => !value.isError))
    assert.match(JSON.stringify(characterAdapter.requests[0]), /map_.*read/)
    assert.doesNotMatch(JSON.stringify(characterAdapter.requests[0]), /map_place_create/)
    assert.match(JSON.stringify(characterAdapter.requests[1].messages), /青河/)
    assert.match(JSON.stringify(organizationAdapter.requests[1].messages), /verified/)
    const [organizationFile] = await readdir(join(world.readRoot, 'organization', 'organizations')); assert.ok(organizationFile)
    characterCalls.push({ name: 'unused', args: {} }, { name: 'organization_read', args: { id: organizationFile.replace(/\.json$/, '') } })
    assert.equal((await call('delegate_character_creator')).isError, false)
    assert.match(JSON.stringify(characterAdapter.requests.at(-1)?.messages), /青河议会/)
    characterCalls.push({ name: 'unused', args: {} }, { name: 'character_create', args: { character: { name: '林岚', summary: '', categories: {}, body: '城邦联系人' } } })
    assert.equal((await call('delegate_character_creator')).isError, false)
    const characterIndex = JSON.parse(await readFile(join(world.readRoot, 'characters', 'index.json'), 'utf8')) as { characters: { id: string }[] }
    const personId = characterIndex.characters[0]?.id; assert.ok(personId)
    organizationCalls.push({ name: 'unused', args: {} }, { name: 'organization_reference_check', args: { kind: 'person', id: personId } })
    assert.equal((await call('delegate_organization')).isError, false)
    assert.match(JSON.stringify(organizationAdapter.requests.at(-1)?.messages), /verified/)
    mapCalls.push({ name: 'unused', args: {} }, { name: 'map_place_create', args: { ...place, name: '白石' } })
    assert.equal((await call('delegate_map')).isError, false)
    assert.equal((await readdir(join(world.readRoot, 'map', 'places'))).length, 2)
    assert.match(await readFile(join(world.readRoot, 'map', 'map.json'), 'utf8'), /河谷/)
  } finally { await parent.dispose() }
})

test('历史、局势、发展规划和专有内容共用地图核验真实地点', async t => {
  const { world, sessionRoot } = await setup(t)
  const directories: Record<string, string[]> = { history: ['events', 'candidates'], situation: ['overviews', 'situations', 'candidates'],
    development: ['macro-development/blueprints', 'macro-development/directions', 'macro-development/proposals', 'storylines/stories', 'storylines/growth-lines', 'character-growth/blueprints', 'character-growth/items', 'candidates'], specific: ['topics', 'items', 'candidates'] }
  for (const [owner, names] of Object.entries(directories)) for (const name of names) await mkdir(join(world.readRoot, owner, name), { recursive: true })
  const configuredWorld = { ...world, agents: [...world.agents, ...Object.keys(directories).map(agentId => ({ agentId, writableRoot: join(world.readRoot, agentId) }))] }
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'test', adapter: new ScriptAdapter() }))
  const common = { sessionRoot, sessionMode: 'create' as const, provider: 'test', model: 'test' }
  const checks = ['history_reference_check', 'situation_reference_check', 'world_development_reference_check', 'world_specific_reference_check']
  const calls = checks.map((): { name: string; args: object }[] => [])
  const adapters = calls.map(value => new ScriptAdapter(value))
  const config = (agentId: string, adapter: ScriptAdapter) => ({ ...common, agentId, sessionId: agentId, adapter })
  const parent = await createWorldInitializationAgentWithWorldWorkspaces([configuredWorld], world.worldId, undefined,
    { singleWriterProcess: true, mapAgent: config('map', new ScriptAdapter([{ name: 'map_overview_create', args: overview }, { name: 'map_place_create', args: place }])),
      historyAgent: config('history', adapters[0]!), initialSituationAgent: config('situation', adapters[1]!),
      worldDevelopmentAgent: config('development', adapters[2]!), worldSpecificAgent: config('specific', adapters[3]!) })
  try {
    const call = async (name: string) => (await parent.context.tools.execute({ calls: [{ type: 'tool-call', id: name as ToolCallId, name, arguments: JSON.stringify({ task: '核对资料' }) }],
      workingDirectory: world.readRoot, session: parent.context.sessions.list()[0]!, signal: new AbortController().signal })).results[0].result
    assert.equal((await call('delegate_map')).isError, false)
    const [file] = await readdir(join(world.readRoot, 'map', 'places')); assert.ok(file)
    for (const [index, name] of checks.entries()) calls[index]!.push({ name, args: { type: 'place', id: file.replace(/\.json$/, '') } })
    const results = await Promise.all(['delegate_history', 'delegate_initial_situation', 'delegate_world_development', 'delegate_world_specific'].map(call))
    assert.ok(results.every(result => !result.isError), JSON.stringify(results))
    assert.match(JSON.stringify(adapters[0]!.requests[1].messages), /verified/)
    for (const adapter of adapters.slice(1)) assert.match(JSON.stringify(adapter.requests[1].messages), /version_unknown/)
    calls[0]!.push({ name: 'unused', args: {} }, { name: 'history_event_create', args: { content: { name: '旧战争', aliases: [], detailLevel: 'overview', summary: '', body: '', time: [], parents: [], childrenCoverage: 'unknown', relations: [], references: [], publicAccounts: [], hidden: { state: 'unknown', note: '' }, reserved: [] } } })
    assert.equal((await call('delegate_history')).isError, false)
    const [eventFile] = await readdir(join(world.readRoot, 'history', 'events')); assert.ok(eventFile)
    calls[1]!.push({ name: 'unused', args: {} }, { name: 'situation_reference_check', args: { type: 'history', id: eventFile.replace(/\.json$/, '') } })
    assert.equal((await call('delegate_initial_situation')).isError, false)
    assert.match(JSON.stringify(adapters[1]!.requests.at(-1)?.messages), /version_unknown/)
  } finally { await parent.dispose() }
})

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
