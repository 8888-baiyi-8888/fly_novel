import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@fly-novel/fs-local'
import { SituationStore } from '@fly-novel/initial-situation'
import { createWorldDevelopmentResolvers } from '../agents/world-development-references.js'
import { createWorldDevelopmentAgent } from '../agents/world-development-agent.js'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@fly-novel/llm'

test('规划引用真实局势方案并拒绝错配及跨世界绑定', async t => {
  const tmp = join(process.cwd(), 'tmp'); await mkdir(tmp, { recursive: true }); const root = await realpath(await mkdtemp(join(tmp, 'development-ref-'))); t.after(() => rm(root, { recursive: true, force: true }))
  const worlds = []
  for (const worldId of ['a', 'b']) {
    const readRoot = join(root, worldId); for (const dir of ['main', 'confirmed', 'catalog', 'situation/overviews', 'situation/situations', 'situation/candidates', ...['macro-development/blueprints', 'macro-development/directions', 'macro-development/proposals', 'storylines/stories', 'storylines/growth-lines', 'character-growth/blueprints', 'character-growth/items', 'candidates'].map(folder => `development/${folder}`)]) await mkdir(join(readRoot, dir), { recursive: true })
    worlds.push({ worldId, readRoot, confirmedRoot: join(readRoot, 'confirmed'), catalogRoot: join(readRoot, 'catalog'), mainAgent: { agentId: 'main', writableRoot: join(readRoot, 'main') }, agents: [{ agentId: 'situation', writableRoot: join(readRoot, 'situation') }, { agentId: 'development', writableRoot: join(readRoot, 'development') }] })
  }
  const world = worlds[0]!; const ctx = new Context(); const fs = await ctx.plugin(LocalFileSystem, { cwd: world.readRoot }); t.after(() => fs.dispose())
  const store = await SituationStore.open({ fs: ctx.fs, root: join(world.readRoot, 'situation'), worldId: world.worldId, phase: 'initialization', access: 'read-write', singleWriterProcess: true }); t.after(() => store.close())
  await store.createStart('起点'); const a = await store.createOverview({ name: '甲', summary: '', coverage: '', reserved: [] }); const b = await store.createOverview({ name: '乙', summary: '', coverage: '', reserved: [] })
  const item = await store.createSituation({ overviewId: a.id, name: '封渠', aliases: [], detailLevel: 'overview', summary: '', body: '', references: [], relations: [], reserved: [] })
  const config = { workspaces: worlds, worldId: world.worldId, situation: { agentId: 'situation', store } }; const refs = await createWorldDevelopmentResolvers(config)
  assert.deepEqual(await refs.resolveSituation?.(a.id, item.id), { worldId: world.worldId, overviewId: a.id, situationId: item.id, version: item.version })
  assert.equal(await refs.resolveSituation?.(b.id, item.id), null); assert.equal(await refs.resolveReference('person', item.id), undefined)
  await assert.rejects(createWorldDevelopmentResolvers({ ...config, worldId: 'b' }), /不匹配/)
  await assert.rejects(createWorldDevelopmentResolvers({ ...config, situation: { agentId: 'main', store } }), /不匹配/)
  class Probe extends LlmAdapter {
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      const names = options.tools?.map(tool => tool.name) ?? []; assert.ok(names.includes('situation_overview_read')); assert.ok(names.includes('world_development_create')); assert.ok(!names.includes('situation_create'))
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '完成' } }; yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  const sessionRoot = join(root, 'sessions'); await mkdir(sessionRoot)
  const agent = await createWorldDevelopmentAgent({ workspaces: worlds, worldId: world.worldId, agentId: 'development', sessionId: 's', sessionRoot, sessionMode: 'create', provider: 'test', model: 'test', adapter: new Probe(), singleWriterProcess: true, references: { situation: config.situation } })
  try { assert.deepEqual(await agent.run({ prompt: '核对局势' }), { content: '完成' }) } finally { await agent.dispose() }
})
