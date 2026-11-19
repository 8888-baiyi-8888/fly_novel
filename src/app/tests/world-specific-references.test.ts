import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@fly-novel/fs-local'
import { SituationStore } from '@fly-novel/initial-situation'
import { DevelopmentStore } from '@fly-novel/world-development'
import { createWorldSpecificResolver } from '../agents/world-specific-references.js'

test('专有内容引用核验真实局势与规划的世界和负责人', async t => {
  const tmp = join(process.cwd(), 'tmp'); await mkdir(tmp, { recursive: true }); const root = await realpath(await mkdtemp(join(tmp, 'specific-ref-'))); t.after(() => rm(root, { recursive: true, force: true }))
  const worlds = []
  const dirs = ['macro-development/blueprints', 'macro-development/directions', 'macro-development/proposals', 'storylines/stories', 'storylines/growth-lines', 'character-growth/blueprints', 'character-growth/items', 'candidates']
  for (const worldId of ['a', 'b']) {
    const readRoot = join(root, worldId); for (const dir of ['main', 'confirmed', 'catalog', 'situation/overviews', 'situation/situations', 'situation/candidates', ...dirs.map(value => `development/${value}`)]) await mkdir(join(readRoot, dir), { recursive: true })
    worlds.push({ worldId, readRoot, confirmedRoot: join(readRoot, 'confirmed'), catalogRoot: join(readRoot, 'catalog'), mainAgent: { agentId: 'main', writableRoot: join(readRoot, 'main') }, agents: ['situation', 'development'].map(agentId => ({ agentId, writableRoot: join(readRoot, agentId) })) })
  }
  const world = worlds[0]!; const ctx = new Context(); const fs = await ctx.plugin(LocalFileSystem, { cwd: world.readRoot }); t.after(() => fs.dispose())
  const situation = await SituationStore.open({ fs: ctx.fs, root: join(world.readRoot, 'situation'), worldId: world.worldId, phase: 'initialization', access: 'read-write', singleWriterProcess: true }); t.after(() => situation.close())
  await situation.createStart('起点'); const overview = await situation.createOverview({ name: '甲', summary: '', coverage: '', reserved: [] })
  const item = await situation.createSituation({ overviewId: overview.id, name: '封渠', aliases: [], detailLevel: 'overview', summary: '', body: '', references: [], relations: [], reserved: [] })
  const development = await DevelopmentStore.open({ fs: ctx.fs, root: join(world.readRoot, 'development'), worldId: world.worldId, phase: 'initialization', access: 'read-write', singleWriterProcess: true }); t.after(() => development.close())
  const story = await development.create('storyline', { name: '水源', summary: '', body: '', reserved: [], applicability: { kind: 'unknown' }, references: [], links: [], person: null })
  const config = { workspaces: worlds, worldId: world.worldId, situation: { agentId: 'situation', store: situation }, development: { agentId: 'development', store: development } }; const resolve = await createWorldSpecificResolver(config)
  assert.deepEqual(await resolve('situation-overview', overview.id), { id: overview.id, worldId: world.worldId, version: overview.version })
  assert.deepEqual(await resolve('situation', item.id), { id: item.id, worldId: world.worldId, version: item.version })
  assert.deepEqual(await resolve('development-storyline', story.id), { id: story.id, worldId: world.worldId, version: story.version })
  assert.equal(await resolve('history', story.id), undefined); assert.equal(await resolve('development-proposal', story.id), null)
  await assert.rejects(createWorldSpecificResolver({ ...config, worldId: 'b' }), /不匹配/)
  await assert.rejects(createWorldSpecificResolver({ ...config, development: { agentId: 'situation', store: development } }), /不匹配/)
})
