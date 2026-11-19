import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@fly-novel/fs-local'
import { MapStore } from '@fly-novel/map'
import { OrganizationStore } from '@fly-novel/organization'
import { HistoryStore } from '@fly-novel/history'
import { CharacterStore, CharacterRelationshipStore } from '@fly-novel/character'
import { createSituationReferenceResolver } from '../agents/initial-situation-references.js'

test('局势引用借用同世界负责人资料并取得实际版本', async t => {
  const tmp = join(process.cwd(), 'tmp'); await mkdir(tmp, { recursive: true }); const root = await realpath(await mkdtemp(join(tmp, 'situation-ref-'))); t.after(() => rm(root, { recursive: true, force: true }))
  const worlds = []
  for (const worldId of ['a', 'b']) {
    const readRoot = join(root, worldId)
    for (const dir of ['main', 'confirmed', 'catalog', 'history/events', 'history/candidates', 'map/places', 'map/connections', 'characters', 'organization/organizations', 'organization/relations', 'organization/memberships']) await mkdir(join(readRoot, dir), { recursive: true })
    worlds.push({ worldId, readRoot, confirmedRoot: join(readRoot, 'confirmed'), catalogRoot: join(readRoot, 'catalog'), mainAgent: { agentId: 'main', writableRoot: join(readRoot, 'main') }, agents: ['history', 'map', 'characters', 'organization'].map(agentId => ({ agentId, writableRoot: join(readRoot, agentId) })) })
  }
  const world = worlds[0]!; const ctx = new Context(); const scope = await ctx.plugin(LocalFileSystem, { cwd: world.readRoot }); t.after(() => scope.dispose())
  const map = await MapStore.open({ fs: ctx.fs, root: join(world.readRoot, 'map'), worldId: world.worldId, access: 'read-write', singleWriterProcess: true }); t.after(() => map.close())
  await map.createOverview({ name: '世界', description: '', scale: { width: 100, height: 100, unit: 'km' }, layers: [{ id: 'area', name: '地区' }], orientation: '北', reserved: [] })
  const place = await map.createPlace({ name: '山门', aliases: [], description: '', detailLevel: 'overview', reserved: [], parents: [{ layerId: 'area', parent: { kind: 'world' }, localBoxes: [[0, 0, 10, 10]], frameBox: [0, 0, 10, 10], coverage: 'complete' }] })
  const history = await HistoryStore.open({ fs: ctx.fs, root: join(world.readRoot, 'history'), worldId: world.worldId, phase: 'initialization', access: 'read-write', singleWriterProcess: true }); t.after(() => history.close())
  const event = await history.create({ name: '战争', aliases: [], detailLevel: 'overview', summary: '', body: '', time: [], parents: [], childrenCoverage: 'unknown', relations: [], references: [], publicAccounts: [], hidden: { state: 'unknown', note: '' }, reserved: [] })
  const org = await OrganizationStore.open({ fs: ctx.fs, root: join(world.readRoot, 'organization'), worldId: world.worldId, phase: 'initialization', access: 'read-write', singleWriterProcess: true }); t.after(() => org.close())
  const institution = await org.createOrganization({ name: '宗门', aliases: [], organizationType: '宗门', detailLevel: 'overview', minLevel: 0, sections: [], reserved: [], locations: [] })
  const other = await org.createOrganization({ name: '分院', aliases: [], organizationType: '宗门', detailLevel: 'overview', minLevel: 0, sections: [], reserved: [], locations: [] })
  const organizationRelation = await org.createRelation({ fromId: institution.id, toId: other.id, kind: 'general', label: '合作', direction: 'two-way', fromMinLevel: 0, toMinLevel: 0, description: '' })
  const chars = await CharacterStore.open(join(world.readRoot, 'characters'), true); t.after(() => chars.close()); const person = await chars.create({ name: '林岚', summary: '', categories: {}, body: '' })
  await mkdir(join(world.readRoot, 'characters', 'relationships'))
  const relationships = await CharacterRelationshipStore.open({ root: join(world.readRoot, 'characters', 'relationships'), worldId: world.worldId, phase: 'initialization', singleWriterProcess: true, resolvePerson: async id => ({ id, worldId: world.worldId }) }); t.after(() => relationships.close())
  const person2 = await chars.create({ name: '顾青', summary: '', categories: {}, body: '' })
  const relation = await relationships.create({ participants: [{ kind: 'linked', id: person.id }, { kind: 'linked', id: person2.id }], relations: [{ name: '师徒', direction: 'a-to-b', description: '' }] })
  const config = { workspaces: worlds, worldId: world.worldId, map: { agentId: 'map', store: map }, history: { agentId: 'history', store: history }, organization: { agentId: 'organization', store: org }, characters: { agentId: 'characters', store: chars }, relationships: { agentId: 'characters', store: relationships } }
  const resolve = await createSituationReferenceResolver(config)
  for (const [type, id] of [['place', place.id], ['history', event.id], ['organization', institution.id], ['organization-relation', organizationRelation.id], ['person', person.id], ['person-relation', relation.document.id]]) {
    const value = await resolve(type!, id!); assert.equal(value?.id, id); assert.ok(value?.version)
  }
  assert.equal(await resolve('person-relation', '00000000-0000-4000-8000-000000000001'), null)
  await assert.rejects(createSituationReferenceResolver({ ...config, worldId: 'b' }), /不匹配/)
  await assert.rejects(createSituationReferenceResolver({ ...config, history: { agentId: 'map', store: history } }), /不匹配/)
})
