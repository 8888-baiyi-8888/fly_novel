import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@fly-novel/fs-local'
import { WorldAccess } from '@fly-novel/util'
import { SituationStore } from '@fly-novel/initial-situation'
import { DevelopmentStore } from '@fly-novel/world-development'
import { SpecificStore } from '@fly-novel/world-specific'
import { DiscussionService, type DiscussionTargetAdapter } from '../discussion/service.js'
import { withExtendedDiscussionAdapter } from '../discussion/extended-adapter.js'
import { TargetPublisher } from '../impact/target-publisher.js'
import { ImpactService } from '../impact/service.js'
import { ReviewService } from '../impact/review.js'
import { BatchCommitService } from '../impact/batch-commit.js'

test('局势、规划和专有内容候选保留原文并拒绝旧候选', async t => {
  const parent = join(process.cwd(), 'tmp'); await mkdir(parent, { recursive: true })
  const root = await realpath(await mkdtemp(join(parent, 'discussion-extended-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const dir of ['world/main', 'world/confirmed', 'world/catalog', 'world/situation/overviews', 'world/situation/situations', 'world/situation/candidates',
    'world/development/macro-development/blueprints', 'world/development/macro-development/directions', 'world/development/macro-development/proposals',
    'world/development/storylines/stories', 'world/development/storylines/growth-lines', 'world/development/character-growth/blueprints',
    'world/development/character-growth/items', 'world/development/candidates', 'world/specific/topics', 'world/specific/items', 'world/specific/candidates',
    'discussion/discussions', 'discussion/candidates', 'reports', 'reviews/reviews', 'reviews/confirmations', 'batches']) await mkdir(join(root, dir), { recursive: true })
  const context = new Context(); const backend = context.plugin(LocalFileSystem, { cwd: root }); await backend; t.after(() => backend.dispose())
  const common = { fs: context.fs, worldId: 'extended-world', phase: 'initialization' as const, access: 'read-write' as const, singleWriterProcess: true as const }
  const situation = await SituationStore.open({ ...common, root: join(root, 'world/situation') }); t.after(() => situation.close())
  const development = await DevelopmentStore.open({ ...common, root: join(root, 'world/development') }); t.after(() => development.close())
  const specific = await SpecificStore.open({ ...common, root: join(root, 'world/specific') }); t.after(() => specific.close())
  await situation.createStart('原起点')
  const overview = await situation.createOverview({ name: '方案', summary: '', coverage: '河谷', reserved: [] })
  const plan = await development.create('direction', { name: '方向', summary: '', body: '原规划', reserved: [], applicability: { kind: 'unknown' }, references: [], links: [], person: null })
  const topic = await specific.create('topic', { name: '规则', aliases: [], detailLevel: 'overview', summary: '', body: '原规则', reserved: [], topicIds: [], links: [], references: [] })
  for (const path of [join(root, 'world/situation', overview.path), join(root, 'world/development', plan.path), join(root, 'world/specific', topic.path)]) {
    await writeFile(path, (await readFile(path, 'utf8')).replace('"suggested"', '"confirmed"'))
  }
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
    const candidate = JSON.stringify({ ...document, ...(target.kind === 'situation-start' ? { description: '新起点' } : { summary: '候选', contentStatus: 'suggested' }) })
    await service.createCandidate(discussion.id, target, candidate, '修改建议')
    assert.equal((await adapter.read(target)).content, current.content)
  }
  await writeFile(join(root, 'world/specific/candidates', `${topic.id}.json`), '旧候选')
  const old = (await service.listCandidates(discussion.id)).find(item => item.value.target.kind === 'specific')!
  await assert.rejects(service.updateCandidate(discussion.id, old.value.id, old.version, old.value.content, '更新'), /已有候选/)
  await rm(join(root, 'world/specific/candidates', `${topic.id}.json`))
  if (!(context.fs instanceof LocalFileSystem)) throw new Error('测试需要本机后端')
  await assert.rejects(TargetPublisher.create(world, context.fs, { specific: { agentId: 'situation', store: specific } }), /负责人不匹配/)
  const publisher = await TargetPublisher.create(world, context.fs, { situation: { agentId: 'situation', store: situation },
    development: { agentId: 'development', store: development }, specific: { agentId: 'specific', store: specific } })
  const candidates = await service.listCandidates(discussion.id)
  const impact = await ImpactService.open({ workspaces: [world], worldId: world.worldId, root: join(root, 'reports'), fs: context.fs, discussion: service, singleWriterProcess: true }); t.after(() => impact.close())
  const review = await ReviewService.open({ workspaces: [world], worldId: world.worldId, root: join(root, 'reviews'), fs: context.fs, discussion: service, impact, singleWriterProcess: true }); t.after(() => review.close())
  const gate = WorldAccess.register([world.readRoot, join(root, 'discussion'), join(root, 'reports'), join(root, 'reviews'), join(root, 'batches')])
  const batch = await BatchCommitService.open({ workspaces: [world], worldId: world.worldId, root: join(root, 'batches'), fs: context.fs,
    gate, discussion: service, impact, review, publisher, sessionRoots: [], singleWriterProcess: true }); t.after(async () => { await batch.close(); await gate.close() })
  let entered!: () => void; let release!: () => void
  const started = new Promise<void>(done => { entered = done }); const held = new Promise<void>(done => { release = done })
  const exclusive = gate.run(async () => { entered(); await held; await specific.readDocument('topic', topic.id) })
  await started
  let finished = false; const waiting = specific.readDocument('topic', topic.id).then(() => { finished = true })
  await new Promise<void>(done => setImmediate(done)); assert.equal(finished, false)
  release(); await Promise.all([exclusive, waiting]); assert.equal(finished, true)
  const expectedContent = await Promise.all(candidates.map(item => publisher.preview(item.value.target, item.value.content)))
  const reports = await Promise.all(candidates.map(item => impact.check(discussion.id, item.value.id)))
  const draft = await review.create(discussion.id, reports.map(item => item.report.id), { findings: [], dependencies: [] })
  const confirmation = await review.confirm(discussion.id, draft.value.id, { reviewVersion: draft.version, confirmContinue: true,
    selectedCandidateIds: candidates.map(item => item.value.id), selections: [], acknowledgedUncovered: reports.flatMap(({ report }) =>
      report.scopes.filter(scope => scope.status === 'uncovered').map(scope => ({ reportId: report.id, scope: scope.name }))) })
  const published = await batch.submit(discussion.id, draft.value.id, confirmation.version)
  assert.equal(published.state, 'completed'); assert.ok(published.items.every(item => item.phase === 'committed' && item.catalogStatus === 'not-configured'))
  for (const [index, item] of candidates.entries()) {
    const expected = expectedContent[index]!
    assert.equal((await adapter.read(item.value.target)).content, expected)
    if (item.value.target.kind !== 'situation-start') assert.match(expected, /"contentStatus": "confirmed"/)
    await assert.rejects(publisher.publish(item.value.target, item.value.content, item.value.baseline), /版本|变化/)
  }
})
