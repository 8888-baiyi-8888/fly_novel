import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@fly-novel/fs-local'
import { MapStore } from '@fly-novel/map'
import { parseOrganization, parseOrganizationMembership, parseOrganizationRelation } from '@fly-novel/organization'
import { LlmAdapter, type GenerateOptions, type StreamChunk, type ToolCallId } from '@fly-novel/llm'
import { CharacterStore } from '@fly-novel/character'
import { initializeCatalog } from '../../world-init/workspace/catalog/format.js'
import type { WorldWorkspaceConfig } from '../../world-init/workspace/config.js'
import configured = require('../call-llm.js')
import { createWorldInitializationAgentWithWorldWorkspaces } from '../agents/index.js'

function call(id: string, name: string, args: object): StreamChunk {
  return { type: 'block-end', index: 0, block: { type: 'tool-call', id: id as ToolCallId, name, arguments: JSON.stringify(args) } }
}
function result(options: GenerateOptions, id: string): Record<string, unknown> {
  const block = options.messages.flatMap(message => message.content).find(item => item.type === 'tool-result' && item.toolCallId === id)
  assert.ok(block && block.type === 'tool-result' && !block.isError, `${id}: ${JSON.stringify(block)}`)
  const text = block.content.find(item => item.type === 'text'); assert.ok(text && text.type === 'text')
  const parsed: unknown = JSON.parse(text.text); assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed))
  return Object.fromEntries(Object.entries(parsed))
}

class OrganizationAdapter extends LlmAdapter {
  private step = 0
  failure: unknown
  constructor(private readonly city: boolean, private readonly placeId: string, private readonly personId: string) { super() }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    try { yield* this.execute(options) } catch (error) { this.failure = error; throw error }
  }
  private async *execute(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.step++
    const first = this.city ? '曲水议会' : '青云宗'
    const second = this.city ? '河谷商盟' : '青云外院'
    const data = (name: string) => ({ name, aliases: [], organizationType: this.city ? '城邦组织' : '宗门', detailLevel: 'overview', minLevel: 0,
      sections: [{ title: '概况', content: this.city ? '水源有限，需要协商' : '开放修行，不预设结局', minLevel: 0 }], locations: [], reserved: [] })
    if (this.step === 1) yield call('first', 'organization_create', { content: { ...data(first), locations: [{ place: { kind: 'linked', id: this.placeId }, purpose: '所在地', minLevel: 0 }] } })
    else if (this.step === 2) { result(options, 'first'); yield call('second', 'organization_create', { content: data(second) }) }
    else if (this.step === 3) {
      yield call('relation', 'organization_relation_create', { content: { fromId: result(options, 'second').id, toId: result(options, 'first').id,
        kind: this.city ? 'general' : 'subordination', label: this.city ? '合作' : '统属', direction: this.city ? 'two-way' : 'one-way', fromMinLevel: 0, toMinLevel: 0, description: '初始关系' } })
      yield call('member', 'organization_membership_create', { content: { organizationId: result(options, 'first').id, person: { kind: 'linked', id: this.personId }, roles: ['负责人'], period: null, description: '实际人物关联', minLevel: 1 } })
    } else if (this.step === 4) {
      result(options, 'relation'); result(options, 'member')
      yield call('clue', 'organization_membership_create', { content: { organizationId: result(options, 'first').id, person: { kind: 'unresolved', description: '身份尚未核实的联络人' }, roles: [], period: null, description: '', minLevel: 2 } })
    } else if (this.step === 5) {
      result(options, 'clue')
      yield call('org-members', 'organization_memberships_read', { organizationId: result(options, 'first').id })
      yield call('person-members', 'organization_memberships_read', { personId: this.personId })
    } else if (this.step === 6) {
      assert.equal((result(options, 'org-members').items as unknown[]).length, 2)
      assert.equal((result(options, 'person-members').items as unknown[]).length, 1)
      yield call('verify', 'organization_reference_check', { kind: 'place', id: this.placeId })
      yield call('catalog', 'catalog_register', { path: `organization/${result(options, 'first').path}`, summary: first })
    } else if (this.step === 7) {
      assert.equal(result(options, 'verify').status, 'verified'); result(options, 'catalog')
      yield call('updated', 'organization_update', { id: result(options, 'first').id, version: result(options, 'first').version,
        content: { ...data(first), detailLevel: 'detailed', locations: [{ place: { kind: 'linked', id: this.placeId }, purpose: '所在地', minLevel: 0 }] } })
    } else if (this.step === 8) {
      result(options, 'updated')
      const record = result(options, 'catalog').record as { revision: string }; assert.ok(record.revision)
      yield call('stale', 'catalog_read', { path: `organization/${result(options, 'first').path}` })
      yield call('source', 'catalog_read_source', { path: `organization/${result(options, 'first').path}`, revision: record.revision })
    } else if (this.step === 9) {
      assert.equal(result(options, 'stale').fileStatus, 'stale')
      const source = result(options, 'source'); assert.match(String(source.content), /detailed/)
      const record = result(options, 'stale').record as { revision: string }
      yield call('catalog-updated', 'catalog_update', { path: `organization/${result(options, 'first').path}`, revision: record.revision, receipt: source.receipt, summary: `${first}详细资料` })
    } else {
      assert.equal(result(options, 'catalog-updated').fileStatus, 'current')
      yield { type: 'block-end', index: 0, block: { type: 'text', text: `组织成果：organization/${result(options, 'first').path}` } }
      yield { type: 'finish', reason: { kind: 'stop' } }; return
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

class ParentAdapter extends LlmAdapter {
  private step = 0
  constructor(private readonly foreignPath: string, private readonly child: OrganizationAdapter) { super() }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.step++
    if (this.step === 1) yield call('delegate', 'delegate_organization', { task: '建立近期组织，核实已有地点和人物，保留未关联线索' })
    else if (this.step === 2) {
      const block = options.messages.flatMap(message => message.content).find(item => item.type === 'tool-result' && item.toolCallId === 'delegate')
      assert.ok(block && block.type === 'tool-result' && !block.isError, `${JSON.stringify(block)}; 子 Agent 断言：${String(this.child.failure)}`)
      const value = block.content.find(item => item.type === 'text'); assert.ok(value && value.type === 'text')
      const match = value.text.match(/organization\/organizations\/[a-f0-9-]+\.json/); assert.ok(match)
      yield call('read', 'read', { file_path: match[0] })
    } else if (this.step === 3) {
      const block = options.messages.flatMap(message => message.content).find(item => item.type === 'tool-result' && item.toolCallId === 'read')
      assert.ok(block && block.type === 'tool-result' && !block.isError); assert.match(JSON.stringify(block.content), /青云宗|曲水议会/)
      yield call('foreign', 'read', { file_path: this.foreignPath })
    }
    else {
      const block = options.messages.flatMap(message => message.content).find(item => item.type === 'tool-result' && item.toolCallId === 'foreign')
      assert.ok(block && block.type === 'tool-result' && block.isError)
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '已核对组织成果' } }
      yield { type: 'finish', reason: { kind: 'stop' } }; return
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

test('修仙与城邦世界通过主 Agent 委派并核对组织、成员和外部引用', { timeout: 30000 }, async t => {
  const tmp = join(process.cwd(), 'tmp'); await mkdir(tmp, { recursive: true })
  const root = await realpath(await mkdtemp(join(tmp, 'organization-e2e-'))); t.after(() => rm(root, { recursive: true, force: true }))
  const sessionRoot = join(root, 'sessions'); await mkdir(sessionRoot)
  const worlds: WorldWorkspaceConfig[] = []
  for (const id of ['cultivation', 'city']) {
    const readRoot = join(root, id)
    for (const dir of ['main', 'organization/organizations', 'organization/relations', 'organization/memberships', 'map/places', 'map/connections', 'characters', 'confirmed', 'catalog']) await mkdir(join(readRoot, dir), { recursive: true })
    const world = { worldId: id, readRoot, confirmedRoot: join(readRoot, 'confirmed'), catalogRoot: join(readRoot, 'catalog'), mainAgent: { agentId: 'main', writableRoot: join(readRoot, 'main') }, agents: [
      { agentId: 'organization', writableRoot: join(readRoot, 'organization') }, { agentId: 'map', writableRoot: join(readRoot, 'map') }, { agentId: 'characters', writableRoot: join(readRoot, 'characters') }] }
    await writeFile(join(world.confirmedRoot, 'private.md'), id); await initializeCatalog(world.catalogRoot, id); worlds.push(world)
  }
  for (const [index, world] of worlds.entries()) {
    const ctx = new Context(); const scope = await ctx.plugin(LocalFileSystem, { cwd: world.readRoot })
    const map = await MapStore.open({ fs: ctx.fs, root: join(world.readRoot, 'map'), worldId: world.worldId, access: 'read-write', singleWriterProcess: true })
    const characters = await CharacterStore.open(join(world.readRoot, 'characters'), true)
    try {
      await map.createOverview({ name: '世界', description: '', scale: { width: 1000, height: 1000, unit: 'km' }, layers: [{ id: 'area', name: '地区' }], orientation: '北', reserved: [] })
      const place = await map.createPlace({ name: '据点', aliases: [], description: '', detailLevel: 'overview', reserved: [], parents: [{ layerId: 'area', parent: { kind: 'world' }, localBoxes: [[0, 0, 100, 100]], frameBox: [0, 0, 100, 100], coverage: 'complete' }] })
      const person = await characters.create({ name: '林岚', summary: '', categories: {}, body: '组织联系人' })
      const child = new OrganizationAdapter(index === 1, place.id, person.id)
      const mock = t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'test', adapter: new ParentAdapter(join(worlds[1-index].confirmedRoot, 'private.md'), child) }))
      const parent = await createWorldInitializationAgentWithWorldWorkspaces(worlds, world.worldId, undefined, { singleWriterProcess: true, catalog: {}, organizationAgent: {
        agentId: 'organization', sessionId: 's', sessionMode: 'create', sessionRoot, provider: 'test', model: 'test', adapter: child,
        references: { map: { agentId: 'map', store: map }, characters: { agentId: 'characters', store: characters } },
      } })
      try { assert.deepEqual(await parent.run({ prompt: '规划组织' }), { content: '已核对组织成果' }) } finally { await parent.dispose(); mock.mock.restore() }
      const load = async (folder: string) => Promise.all((await readdir(join(world.readRoot, 'organization', folder))).map(name => readFile(join(world.readRoot, 'organization', folder, name), 'utf8')))
      const organizations = (await load('organizations')).map(parseOrganization); const relations = (await load('relations')).map(parseOrganizationRelation); const members = (await load('memberships')).map(parseOrganizationMembership)
      assert.equal(organizations.length, 2); assert.ok(organizations.every(item => item.worldId === world.worldId && item.reviewStatus === 'suggested'))
      assert.equal(relations.length, 1); assert.equal(members.length, 2)
      assert.ok(members.some(item => item.person.kind === 'linked' && item.person.id === person.id)); assert.ok(members.some(item => item.person.kind === 'unresolved'))
      assert.ok(organizations.some(item => item.locations.some(location => location.place.kind === 'linked' && location.place.id === place.id)))
      assert.match(await readFile(join(world.catalogRoot, 'catalog.json'), 'utf8'), index === 1 ? /曲水议会/ : /青云宗/)
    } finally { await characters.close(); await map.close(); await scope.dispose() }
  }
})
