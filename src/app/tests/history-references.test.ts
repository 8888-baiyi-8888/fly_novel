import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@fly-novel/fs-local'
import { MapStore } from '@fly-novel/map'
import { OrganizationStore } from '@fly-novel/organization'
import { CharacterStore } from '@fly-novel/character'
import { createHistoryReferenceResolvers } from '../../world-init/storage/history-references.js'
import { createHistoryAgent } from '../agents/history-agent.js'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@fly-novel/llm'

test('历史引用只借用同世界和正确负责人持有的地图、组织和人物服务', async t => {
  const tmp = join(process.cwd(), 'tmp'); await mkdir(tmp, { recursive: true })
  const root = await realpath(await mkdtemp(join(tmp, 'history-ref-'))); t.after(() => rm(root, { recursive: true, force: true }))
  const worlds = []
  for (const id of ['world-a', 'world-b']) {
    const readRoot = join(root, id)
    for (const dir of ['main', 'confirmed', 'catalog', 'history/events', 'history/candidates', 'map/places', 'map/connections', 'characters', 'organization/organizations', 'organization/relations', 'organization/memberships']) await mkdir(join(readRoot, dir), { recursive: true })
    worlds.push({ worldId: id, readRoot, confirmedRoot: join(readRoot, 'confirmed'), catalogRoot: join(readRoot, 'catalog'), mainAgent: { agentId: 'main', writableRoot: join(readRoot, 'main') },
      agents: [{ agentId: 'map', writableRoot: join(readRoot, 'map') }, { agentId: 'characters', writableRoot: join(readRoot, 'characters') }, { agentId: 'organization', writableRoot: join(readRoot, 'organization') }, { agentId: 'history', writableRoot: join(readRoot, 'history') }] })
  }
  const world = worlds[0]!; const ctx = new Context(); const scope = await ctx.plugin(LocalFileSystem, { cwd: world.readRoot }); t.after(() => scope.dispose())
  const map = await MapStore.open({ fs: ctx.fs, root: join(world.readRoot, 'map'), worldId: world.worldId, access: 'read-write', singleWriterProcess: true }); t.after(() => map.close())
  await map.createOverview({ name: '世界', description: '', scale: { width: 1000, height: 1000, unit: 'km' }, layers: [{ id: 'area', name: '地区' }], orientation: '北', reserved: [] })
  const place = await map.createPlace({ name: '山门', aliases: [], description: '', detailLevel: 'overview', reserved: [], parents: [{ layerId: 'area', parent: { kind: 'world' }, localBoxes: [[0, 0, 100, 100]], frameBox: [0, 0, 100, 100], coverage: 'complete' }] })
  const chars = await CharacterStore.open(join(world.readRoot, 'characters'), true); t.after(() => chars.close())
  const person = await chars.create({ name: '林岚', summary: '', categories: {}, body: '' })
  const org = await OrganizationStore.open({ fs: ctx.fs, root: join(world.readRoot, 'organization'), worldId: world.worldId, phase: 'initialization', access: 'read-write', singleWriterProcess: true }); t.after(() => org.close())
  const institution = await org.createOrganization({ name: '青云宗', aliases: [], organizationType: '宗门', detailLevel: 'overview', minLevel: 0, sections: [], reserved: [], locations: [] })
  const config = { workspaces: worlds, worldId: world.worldId, map: { agentId: 'map', store: map }, characters: { agentId: 'characters', store: chars }, organization: { agentId: 'organization', store: org } }
  const refs = await createHistoryReferenceResolvers(config)
  assert.deepEqual(await refs.resolvePlace?.(place.id), { id: place.id, worldId: world.worldId })
  assert.deepEqual(await refs.resolvePerson?.(person.id), { id: person.id, worldId: world.worldId })
  assert.deepEqual(await refs.resolveOrganization?.(institution.id), { id: institution.id, worldId: world.worldId })
  await assert.rejects(createHistoryReferenceResolvers({ ...config, worldId: 'world-b' }), /不匹配/)
  await assert.rejects(createHistoryReferenceResolvers({ ...config, organization: { agentId: 'map', store: org } }), /不匹配/)
  class Probe extends LlmAdapter {
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      const names = options.tools?.map(tool => tool.name) ?? []
      for (const name of ['map_place_read', 'organization_read', 'character_read']) assert.ok(names.includes(name))
      for (const name of ['map_place_create', 'organization_create', 'character_create']) assert.ok(!names.includes(name))
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '完成' } }; yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  const sessionRoot = join(root, 'sessions'); await mkdir(sessionRoot)
  const agent = await createHistoryAgent({ workspaces: worlds, worldId: world.worldId, agentId: 'history', sessionId: 's', sessionMode: 'create', sessionRoot,
    provider: 'test', model: 'test', adapter: new Probe(), singleWriterProcess: true, references: { map: config.map, characters: config.characters, organization: config.organization } })
  try { assert.deepEqual(await agent.run({ prompt: '核查引用' }), { content: '完成' }) } finally { await agent.dispose() }
  assert.equal((await map.readPlace(place.id)).document.name, '山门')
})
