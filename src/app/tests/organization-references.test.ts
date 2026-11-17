import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@fly-novel/fs-local'
import { MapStore } from '@fly-novel/map'
import { OrganizationStore } from '@fly-novel/organization'
import { CharacterStore } from '../../world-init/character/store.js'
import { createOrganizationReferenceResolvers } from '../agents/organization-references.js'

test('组织引用复用同世界真实地图和角色服务，并拒绝跨世界绑定', async t => {
  const temp = join(process.cwd(), 'tmp'); await mkdir(temp, { recursive: true })
  const root = await realpath(await mkdtemp(join(temp, 'organization-refs-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const worlds = []
  for (const id of ['world-a', 'world-b']) {
    const readRoot = join(root, id)
    for (const dir of ['main', 'confirmed', 'catalog', 'map/places', 'map/connections', 'characters', 'organization/organizations', 'organization/relations', 'organization/memberships']) await mkdir(join(readRoot, dir), { recursive: true })
    worlds.push({ worldId: id, readRoot, confirmedRoot: join(readRoot, 'confirmed'), catalogRoot: join(readRoot, 'catalog'), mainAgent: { agentId: 'main', writableRoot: join(readRoot, 'main') },
      agents: [{ agentId: 'map', writableRoot: join(readRoot, 'map') }, { agentId: 'characters', writableRoot: join(readRoot, 'characters') }, { agentId: 'organization', writableRoot: join(readRoot, 'organization') }] })
  }
  const world = worlds[0]; const ctx = new Context(); const scope = await ctx.plugin(LocalFileSystem, { cwd: world.readRoot }); t.after(() => scope.dispose())
  const map = await MapStore.open({ fs: ctx.fs, root: join(world.readRoot, 'map'), worldId: world.worldId, access: 'read-write', singleWriterProcess: true }); t.after(() => map.close())
  await map.createOverview({ name: '世界', description: '', scale: { width: 1000, height: 1000, unit: 'km' }, layers: [{ id: 'admin', name: '行政' }], orientation: '北', reserved: [] })
  const place = await map.createPlace({ name: '山门', aliases: [], description: '', detailLevel: 'overview', reserved: [],
    parents: [{ layerId: 'admin', parent: { kind: 'world' }, localBoxes: [[0, 0, 100, 100]], frameBox: [0, 0, 100, 100], coverage: 'complete' }] })
  const characters = await CharacterStore.open(join(world.readRoot, 'characters'), true); t.after(() => characters.close())
  const person = await characters.create({ name: '林岚', summary: '', categories: {}, body: '宗门长老' })
  const config = { workspaces: worlds, worldId: world.worldId, map: { agentId: 'map', store: map }, characters: { agentId: 'characters', store: characters } }
  const resolvers = await createOrganizationReferenceResolvers(config)
  await assert.rejects(createOrganizationReferenceResolvers({ ...config, worldId: 'world-b' }), /不匹配/)
  await assert.rejects(createOrganizationReferenceResolvers({ ...config, characters: { agentId: 'map', store: characters } }), /不匹配/)
  const organization = await OrganizationStore.open({ fs: ctx.fs, root: join(world.readRoot, 'organization'), worldId: world.worldId, phase: 'initialization', access: 'read-write', singleWriterProcess: true, ...resolvers }); t.after(() => organization.close())
  const record = await organization.createOrganization({ name: '青云宗', aliases: [], organizationType: '宗门', detailLevel: 'overview', minLevel: 0, sections: [], reserved: [],
    locations: [{ place: { kind: 'linked', id: place.id }, purpose: '山门', minLevel: 0 }] })
  await organization.createMembership({ organizationId: record.id, person: { kind: 'linked', id: person.id }, roles: ['长老'], period: null, description: '', minLevel: 1 })
  assert.deepEqual(await organization.checkReference('place', place.id), { status: 'verified' })
  assert.deepEqual(await organization.checkReference('person', person.id), { status: 'verified' })
  await unlink(join(world.readRoot, 'map', place.path))
  assert.deepEqual(await organization.checkReference('place', place.id), { status: 'not_found' })
  assert.equal((await organization.readOrganization(record.id)).document.locations[0].place.kind, 'linked')
})
