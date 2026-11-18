import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@fly-novel/fs-local'
import { MapStore } from '@fly-novel/map'
import { OrganizationStore } from '@fly-novel/organization'
import { CharacterStore } from '@fly-novel/character'
import { LlmAdapter, type GenerateOptions, type StreamChunk, type ToolCallId } from '@fly-novel/llm'
import { createCharacterCreator } from '../agents/character-creator.js'
import { createWorldInitializationAgentWithWorldWorkspaces } from '../agents/world-initialization.js'
import { createMapAgent } from '../agents/map-agent.js'
import { createOrganizationAgent } from '../agents/organization-agent.js'
import configured = require('../call-llm.js')

class Script extends LlmAdapter {
  requests: GenerateOptions[] = []
  constructor(private readonly cross = true) { super() }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const n = this.requests.length
    const names = options.tools?.map(tool => tool.name) ?? []
    for (const name of ['character_relationship_create', 'character_relationship_search', 'character_initialization_update', ...(this.cross ? ['map_overview_read', 'organization_memberships_read'] : [])]) assert.ok(names.includes(name), name)
    assert.match(JSON.stringify(options.tools?.find(tool => tool.name === 'character_create')), /categories.*id.*name/)
    assert.match(JSON.stringify(options.tools?.find(tool => tool.name === 'character_relationship_create')), /a-to-b.*b-to-a.*two-way/)
    assert.ok(!names.includes('map_place_create')); assert.ok(!names.includes('organization_create'))
    const result = (id: string) => {
      const block = options.messages.flatMap(message => message.content).find(value => value.type === 'tool-result' && value.toolCallId === id)
      assert.ok(block && block.type === 'tool-result' && !block.isError, JSON.stringify(block))
      const text = block.content.find(value => value.type === 'text'); assert.ok(text && text.type === 'text')
      return JSON.parse(text.text)
    }
    let call: { id: string; name: string; args: object } | undefined
    if (n === 1 || n === 2) call = { id: `person-${n}`, name: 'character_create', args: { character: { name: n === 1 ? '林岚' : '顾青', summary: '', categories: {}, body: '初始资料' } } }
    else if (n === 3) call = { id: 'relationship', name: 'character_relationship_create', args: { relationship: {
      participants: [{ kind: 'linked', id: result('person-1').id }, { kind: 'linked', id: result('person-2').id }],
      relations: [{ name: '师徒', direction: 'a-to-b', description: '已有关系' }] } } }
    else if (n === 4) call = { id: 'search-a', name: 'character_relationship_search', args: { personId: result('person-1').id } }
    else if (n === 5) { assert.equal(result('search-a').total, 1); call = { id: 'search-b', name: 'character_relationship_search', args: { personId: result('person-2').id } } }
    else if (n === 6) { assert.equal(result('search-b').total, 1); call = { id: 'read', name: 'character_initialization_read', args: { id: result('person-1').id } } }
    else if (n === 7) call = { id: 'update', name: 'character_initialization_update', args: { id: result('person-1').id, version: result('read').version,
      character: { name: '林岚', summary: '', categories: {}, body: '更新资料' } } }
    else if (n === 8) {
      result('update')
      if (!this.cross) { yield { type: 'block-end', index: 0, block: { type: 'text', text: '人物关系已建立' } }; yield { type: 'finish', reason: { kind: 'stop' } }; return }
      const calls = [{ id: 'map', name: 'map_overview_read', args: {} }, { id: 'organization', name: 'organization_search', args: {} },
        { id: 'memberships', name: 'organization_memberships_read', args: { personId: result('person-1').id } }]
      for (const [index, item] of calls.entries()) yield { type: 'block-end', index, block: { type: 'tool-call', id: item.id as ToolCallId, name: item.name, arguments: JSON.stringify(item.args) } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }; return
    }
    else { assert.match(JSON.stringify(result('map')), /世界/); assert.match(JSON.stringify(result('organization')), /青云宗/); result('memberships'); yield { type: 'block-end', index: 0, block: { type: 'text', text: '人物关系已建立' } }; yield { type: 'finish', reason: { kind: 'stop' } }; return }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: call.id as ToolCallId, name: call.name, arguments: JSON.stringify(call.args) } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

test('角色创建 Agent 装配人物关系及可信跨模块只读工具并释放资源', async t => {
  const temp = join(process.cwd(), 'tmp'); await mkdir(temp, { recursive: true })
  const root = await realpath(await mkdtemp(join(temp, 'character-assembly-'))); t.after(() => rm(root, { recursive: true, force: true }))
  const readRoot = join(root, 'world'); const sessionRoot = join(root, 'sessions')
  for (const name of ['main', 'confirmed', 'catalog', 'characters', 'map/places', 'map/connections', 'organization/organizations', 'organization/relations', 'organization/memberships']) await mkdir(join(readRoot, name), { recursive: true })
  await mkdir(sessionRoot)
  const world = { worldId: 'world-a', readRoot, confirmedRoot: join(readRoot, 'confirmed'), catalogRoot: join(readRoot, 'catalog'), mainAgent: { agentId: 'main', writableRoot: join(readRoot, 'main') }, agents: [
    { agentId: 'creator', writableRoot: join(readRoot, 'characters') }, { agentId: 'map', writableRoot: join(readRoot, 'map') }, { agentId: 'organization', writableRoot: join(readRoot, 'organization') }] }
  const otherRoot = join(root, 'other')
  for (const name of ['main', 'confirmed', 'catalog', 'characters', 'map', 'organization']) await mkdir(join(otherRoot, name), { recursive: true })
  const other = { worldId: 'world-b', readRoot: otherRoot, confirmedRoot: join(otherRoot, 'confirmed'), catalogRoot: join(otherRoot, 'catalog'),
    mainAgent: { agentId: 'main', writableRoot: join(otherRoot, 'main') }, agents: [
      { agentId: 'creator', writableRoot: join(otherRoot, 'characters') }, { agentId: 'map', writableRoot: join(otherRoot, 'map') }, { agentId: 'organization', writableRoot: join(otherRoot, 'organization') }] }
  const ctx = new Context(); const scope = await ctx.plugin(LocalFileSystem, { cwd: readRoot }); t.after(() => scope.dispose())
  const map = await MapStore.open({ fs: ctx.fs, root: join(readRoot, 'map'), worldId: world.worldId, access: 'read-write', singleWriterProcess: true }); t.after(() => map.close())
  await map.createOverview({ name: '世界', description: '', scale: { width: 1000, height: 1000, unit: 'km' }, layers: [{ id: 'admin', name: '行政' }], orientation: '北', reserved: [] })
  const org = await OrganizationStore.open({ fs: ctx.fs, root: join(readRoot, 'organization'), worldId: world.worldId, phase: 'initialization', access: 'read-write', singleWriterProcess: true }); t.after(() => org.close())
  await org.createOrganization({ name: '青云宗', aliases: [], organizationType: '宗门', detailLevel: 'overview', minLevel: 0, sections: [], reserved: [], locations: [] })
  const adapter = new Script()
  const config = { worldId: world.worldId, agentId: 'creator', sessionId: 'session', sessionMode: 'create' as const, sessionRoot,
    characterRoot: join(readRoot, 'characters'), initializeCharacters: true, readRoot, provider: 'test', model: 'test', adapter, defaultCharacterCount: 2,
    workspaces: [world, other], references: { map: { agentId: 'map', store: map }, organization: { agentId: 'organization', store: org } } }
  await assert.rejects(createCharacterCreator({ ...config, references: { map: { agentId: 'organization', store: map } } }), /不匹配/)
  await assert.rejects(createCharacterCreator({ ...config, worldId: other.worldId, readRoot: otherRoot, characterRoot: join(otherRoot, 'characters') }), /不匹配/)
  const creator = await createCharacterCreator(config)
  await assert.rejects(createCharacterCreator(config), /使用|占用/)
  try { assert.deepEqual(await creator.run({ prompt: '创建已有师徒关系' }), { content: '人物关系已建立' }) } finally { await creator.dispose() }
  const store = await CharacterStore.open(config.characterRoot); const characters = await store.query({}); assert.equal(characters.length, 2)
  const first = characters.find(value => value.name === '林岚'); assert.ok(first)
  assert.equal((await store.read(first.id)).body, '更新资料\n'); await store.close()
  const relation = adapter.requests.flatMap(value => value.messages).flatMap(value => value.content).find(value => value.type === 'tool-result' && value.toolCallId === 'relationship')
  assert.ok(relation && relation.type === 'tool-result' && !relation.isError)
  const content = relation.content.find(value => value.type === 'text'); assert.ok(content && content.type === 'text')
  const id: string = JSON.parse(content.text).document.id
  assert.match(await readFile(join(config.characterRoot, 'relationships', `${id}.json`), 'utf8'), /师徒/)
  assert.equal((await map.readOverview()).document.name, '世界')
  class Resume extends LlmAdapter {
    private count = 0
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      assert.match(JSON.stringify(options.messages), /创建已有师徒关系/)
      if (++this.count === 1) {
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'resume-search' as ToolCallId, name: 'character_relationship_search', arguments: JSON.stringify({ personId: first!.id }) } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        const result = options.messages.flatMap(message => message.content).find(value => value.type === 'tool-result' && value.toolCallId === 'resume-search')
        assert.ok(result && result.type === 'tool-result' && !result.isError)
        assert.match(JSON.stringify(result.content), /师徒/)
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '已读取关系' } }; yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
  const resumed = await createCharacterCreator({ ...config, initializeCharacters: false, sessionMode: 'resume', adapter: new Resume() })
  try { assert.deepEqual(await resumed.run({ prompt: '继续' }), { content: '已读取关系' }) } finally { await resumed.dispose() }
  class Probe extends LlmAdapter {
    private count = 0
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      assert.ok(options.tools?.some(tool => tool.name === 'map_overview_read'))
      assert.ok(options.tools?.some(tool => tool.name === 'organization_memberships_read'))
      assert.ok(!options.tools?.some(tool => tool.name === 'organization_create'))
      if (++this.count === 1) {
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'probe' as ToolCallId, name: 'map_overview_read', arguments: '{}' } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        const result = options.messages.flatMap(message => message.content).find(value => value.type === 'tool-result' && value.toolCallId === 'probe')
        assert.ok(result && result.type === 'tool-result' && !result.isError)
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '已查阅' } }; yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
  class Delegate extends LlmAdapter {
    private count = 0
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      if (++this.count === 1) { yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'delegate' as ToolCallId, name: 'delegate_character_creator', arguments: '{"task":"查阅地图"}' } }; yield { type: 'finish', reason: { kind: 'tool-calls' } } }
      else { const result = options.messages.flatMap(message => message.content).find(value => value.type === 'tool-result' && value.toolCallId === 'delegate'); assert.ok(result && result.type === 'tool-result' && !result.isError); assert.match(JSON.stringify(result.content), /已查阅/); yield { type: 'block-end', index: 0, block: { type: 'text', text: '委派完成' } }; yield { type: 'finish', reason: { kind: 'stop' } } }
    }
  }
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'test', adapter: new Delegate() }))
  const parent = await createWorldInitializationAgentWithWorldWorkspaces([world, other], world.worldId, { agentId: 'creator', sessionId: 'delegated', sessionMode: 'create', sessionRoot,
    provider: 'test', model: 'test', adapter: new Probe(), defaultCharacterCount: 2, initializeCharacters: false, references: config.references }, { singleWriterProcess: true })
  try { assert.deepEqual(await parent.run({ prompt: '委派人物 Agent 查阅地图' }), { content: '委派完成' }) } finally { await parent.dispose() }
  assert.equal((await map.readOverview()).document.name, '世界')
})

test('主 Agent 委派角色创建并保存可重新读取的人物关系', async t => {
  const temp = join(process.cwd(), 'tmp'); await mkdir(temp, { recursive: true })
  const root = await realpath(await mkdtemp(join(temp, 'character-delegation-'))); t.after(() => rm(root, { recursive: true, force: true }))
  const readRoot = join(root, 'world'); const sessionRoot = join(root, 'sessions')
  for (const name of ['main', 'confirmed', 'catalog', 'characters']) await mkdir(join(readRoot, name), { recursive: true })
  await mkdir(sessionRoot)
  const world = { worldId: 'world-b', readRoot, confirmedRoot: join(readRoot, 'confirmed'), catalogRoot: join(readRoot, 'catalog'),
    mainAgent: { agentId: 'main', writableRoot: join(readRoot, 'main') }, agents: [{ agentId: 'creator', writableRoot: join(readRoot, 'characters') }] }
  class Parent extends LlmAdapter {
    private count = 0
    override async *stream(): AsyncIterable<StreamChunk> {
      if (++this.count === 1) { yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'delegate' as ToolCallId, name: 'delegate_character_creator', arguments: JSON.stringify({ task: '创建师徒人物' }) } }; yield { type: 'finish', reason: { kind: 'tool-calls' } } }
      else { yield { type: 'block-end', index: 0, block: { type: 'text', text: '已完成委派' } }; yield { type: 'finish', reason: { kind: 'stop' } } }
    }
  }
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'test', adapter: new Parent() }))
  const child = new Script(false)
  const parent = await createWorldInitializationAgentWithWorldWorkspaces([world], world.worldId, { agentId: 'creator', sessionId: 'child', sessionMode: 'create', sessionRoot,
    provider: 'test', model: 'test', adapter: child, defaultCharacterCount: 2, initializeCharacters: true }, { singleWriterProcess: true })
  try { assert.deepEqual(await parent.run({ prompt: '委派人物设定' }), { content: '已完成委派' }); assert.equal(parent.context.tools.get('character_relationship_create'), undefined) }
  finally { await parent.dispose() }
  const store = await CharacterStore.open(join(readRoot, 'characters')); const people = await store.query({}); assert.equal(people.length, 2); await store.close()
  assert.ok(child.requests.length >= 8)
  const result = child.requests.flatMap(request => request.messages).flatMap(message => message.content).find(value => value.type === 'tool-result' && value.toolCallId === 'relationship')
  assert.ok(result && result.type === 'tool-result' && !result.isError)
  const block = result.content.find(value => value.type === 'text'); assert.ok(block && block.type === 'text')
  assert.match(await readFile(join(readRoot, 'characters', 'relationships', `${JSON.parse(block.text).document.id}.json`), 'utf8'), /师徒/)
})

test('人物、地图和组织 Agent 可在同一世界同时运行并释放各自身份', async t => {
  const temp = join(process.cwd(), 'tmp'); await mkdir(temp, { recursive: true })
  const root = await realpath(await mkdtemp(join(temp, 'character-coexist-'))); t.after(() => rm(root, { recursive: true, force: true }))
  const readRoot = join(root, 'world'); const sessionRoot = join(root, 'sessions')
  for (const name of ['main', 'confirmed', 'catalog', 'characters', 'map/places', 'map/connections', 'organization/organizations', 'organization/relations', 'organization/memberships']) await mkdir(join(readRoot, name), { recursive: true })
  await mkdir(sessionRoot)
  const world = { worldId: 'coexist-world', readRoot, confirmedRoot: join(readRoot, 'confirmed'), catalogRoot: join(readRoot, 'catalog'), mainAgent: { agentId: 'main', writableRoot: join(readRoot, 'main') }, agents: [
    { agentId: 'creator', writableRoot: join(readRoot, 'characters') }, { agentId: 'map', writableRoot: join(readRoot, 'map') }, { agentId: 'organization', writableRoot: join(readRoot, 'organization') }] }
  class Idle extends LlmAdapter { override async *stream(): AsyncIterable<StreamChunk> { yield { type: 'block-end', index: 0, block: { type: 'text', text: '完成' } }; yield { type: 'finish', reason: { kind: 'stop' } } } }
  const common = { workspaces: [world], worldId: world.worldId, sessionMode: 'create' as const, sessionRoot, provider: 'test', model: 'test', adapter: new Idle(), singleWriterProcess: true as const }
  const map = await createMapAgent({ ...common, agentId: 'map', sessionId: 'map' })
  const organization = await createOrganizationAgent({ ...common, agentId: 'organization', sessionId: 'organization' })
  const creator = await createCharacterCreator({ ...common, agentId: 'creator', sessionId: 'creator', characterRoot: join(readRoot, 'characters'), readRoot, initializeCharacters: true, defaultCharacterCount: 1 })
  try {
    assert.deepEqual(await Promise.all([map.run({ prompt: '地图' }), organization.run({ prompt: '组织' }), creator.run({ prompt: '人物' })]), [{ content: '完成' }, { content: '完成' }, { content: '完成' }])
  } finally { await creator.dispose(); await organization.dispose(); await map.dispose() }
  const reopened = await createMapAgent({ ...common, agentId: 'map', sessionId: 'map', sessionMode: 'resume' }); await reopened.dispose()
})
