import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@fly-novel/fs-local'
import { SituationStore } from '@fly-novel/initial-situation'
import { DevelopmentStore } from '@fly-novel/world-development'
import { SpecificStore } from '@fly-novel/world-specific'
import { DiscussionService, type DiscussionTargetAdapter } from '../discussion/service.js'
import { withExtendedDiscussionAdapter } from '../discussion/extended-adapter.js'

test('局势、规划和专有内容候选保留原文并拒绝旧候选', async t => {
  const parent = join(process.cwd(), 'tmp'); await mkdir(parent, { recursive: true })
  const root = await realpath(await mkdtemp(join(parent, 'discussion-extended-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const dir of ['world/main', 'world/confirmed', 'world/catalog', 'world/situation/overviews', 'world/situation/situations', 'world/situation/candidates',
    'world/development/macro-development/blueprints', 'world/development/macro-development/directions', 'world/development/macro-development/proposals',
    'world/development/storylines/stories', 'world/development/storylines/growth-lines', 'world/development/character-growth/blueprints',
    'world/development/character-growth/items', 'world/development/candidates', 'world/specific/topics', 'world/specific/items', 'world/specific/candidates',
    'discussion/discussions', 'discussion/candidates']) await mkdir(join(root, dir), { recursive: true })
  const context = new Context(); const backend = context.plugin(LocalFileSystem, { cwd: root }); await backend; t.after(() => backend.dispose())
  const common = { fs: context.fs, worldId: 'extended-world', phase: 'initialization' as const, access: 'read-write' as const, singleWriterProcess: true as const }
  const situation = await SituationStore.open({ ...common, root: join(root, 'world/situation') }); t.after(() => situation.close())
  const development = await DevelopmentStore.open({ ...common, root: join(root, 'world/development') }); t.after(() => development.close())
  const specific = await SpecificStore.open({ ...common, root: join(root, 'world/specific') }); t.after(() => specific.close())
  await situation.createStart('原起点')
  const overview = await situation.createOverview({ name: '方案', summary: '', coverage: '河谷', reserved: [] })
  const plan = await development.create('direction', { name: '方向', summary: '', body: '原规划', reserved: [], applicability: { kind: 'unknown' }, references: [], links: [], person: null })
  const topic = await specific.create('topic', { name: '规则', aliases: [], detailLevel: 'overview', summary: '', body: '原规则', reserved: [], topicIds: [], links: [], references: [] })
  const world = { worldId: 'extended-world', readRoot: join(root, 'world'), confirmedRoot: join(root, 'world/confirmed'), catalogRoot: join(root, 'world/catalog'),
    mainAgent: { agentId: 'main', writableRoot: join(root, 'world/main') }, agents: [
      { agentId: 'situation', writableRoot: join(root, 'world/situation') }, { agentId: 'development', writableRoot: join(root, 'world/development') },
      { agentId: 'specific', writableRoot: join(root, 'world/specific') }] }
  const base: DiscussionTargetAdapter = { async read() { throw new Error('未支持') }, async validate() { throw new Error('未支持') }, async validateStored() { throw new Error('未支持') }, async assertNoLegacyCandidate() { throw new Error('未支持') } }
  const adapter = withExtendedDiscussionAdapter(base, world, { situation: { agentId: 'situation', store: situation }, development: { agentId: 'development', store: development }, specific: { agentId: 'specific', store: specific } })
  const service = await DiscussionService.open({ worldId: world.worldId, root: join(root, 'discussion'), worldRoots: [world.readRoot], fs: context.fs, adapter, singleWriterProcess: true }); t.after(() => service.close())
  const targets = [{ kind: 'situation-start' as const }, { kind: 'situation' as const, documentKind: 'overview' as const, id: overview.id },
    { kind: 'development' as const, documentKind: 'direction' as const, id: plan.id }, { kind: 'specific' as const, documentKind: 'topic' as const, id: topic.id }]
  const discussion = await service.createDiscussion(targets[0]!, 'session')
  for (const target of targets) {
    const current = await adapter.read(target)
    const document: unknown = JSON.parse(current.content)
    assert.ok(document && typeof document === 'object')
    const candidate = JSON.stringify({ ...document, ...(target.kind === 'situation-start' ? { description: '新起点' } : { summary: '候选' }) })
    await service.createCandidate(discussion.id, target, candidate, '修改建议')
    assert.equal((await adapter.read(target)).content, current.content)
  }
  await writeFile(join(root, 'world/specific/candidates', `${topic.id}.json`), '旧候选')
  const old = (await service.listCandidates(discussion.id)).find(item => item.value.target.kind === 'specific')!
  await assert.rejects(service.updateCandidate(discussion.id, old.value.id, old.version, old.value.content, '更新'), /已有候选/)
})
