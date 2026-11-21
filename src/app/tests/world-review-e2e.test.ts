import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@fly-novel/fs-local'
import { MapStore, formatMapDocument } from '@fly-novel/map'
import { LlmAdapter, type GenerateOptions, type StreamChunk, type ToolCallId } from '@fly-novel/llm'
import { WorldAccess } from '@fly-novel/util'
import configured = require('../call-llm.js')
import { createWorldInitializationAgentWithWorldWorkspaces } from '../agents/index.js'
import { DiscussionService } from '../../world-init/discussion/service.js'
import { createInitialDiscussionAdapter } from '../../world-init/discussion/initial-adapters.js'
import { ImpactService } from '../../world-init/impact/service.js'
import { ReviewService } from '../../world-init/impact/review.js'
import { TargetPublisher } from '../../world-init/impact/target-publisher.js'
import { BatchCommitService } from '../../world-init/impact/batch-commit.js'

class ReviewAdapter extends LlmAdapter {
  private step = 0
  constructor(private readonly content: string) { super() }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const step = this.step++
    if (step === 3) {
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '模型声称用户已经确认。' } }
      yield { type: 'finish', reason: { kind: 'stop' } }; return
    }
    let name: string; let args: object
    if (step === 0) { name = 'discussion_read'; args = {} }
    else if (step === 1) { name = 'discussion_prepare'; args = { content: this.content, summary: '调整城门规则' } }
    else {
      const blocks = options.messages.flatMap(message => message.content).filter(block => block.type === 'tool-result')
      const last = blocks.at(-1); assert.ok(last && last.type === 'tool-result' && !last.isError)
      const text = last.content.find(item => item.type === 'text'); assert.ok(text && text.type === 'text')
      const value: unknown = JSON.parse(text.text)
      assert.ok(value && typeof value === 'object' && 'value' in value && value.value && typeof value.value === 'object' && 'id' in value.value && typeof value.value.id === 'string')
      name = 'impact_check'; args = { candidateId: value.value.id }
    }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `review-${step}` as ToolCallId, name, arguments: JSON.stringify(args) } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

test('固定模型讨论、跨世界隔离、审阅选择和版本变化', async t => {
  const temp = join(process.cwd(), 'tmp'); await mkdir(temp, { recursive: true })
  const root = await realpath(await mkdtemp(join(temp, 'review-e2e-'))); t.after(() => rm(root, { recursive: true, force: true }))
  for (const world of ['a', 'b']) for (const dir of ['main', 'confirmed', 'catalog', 'map/places', 'map/connections']) await mkdir(join(root, world, dir), { recursive: true })
  for (const dir of ['pending-a/discussions', 'pending-a/candidates', 'pending-b/discussions', 'pending-b/candidates', 'reports-a', 'reports-b', 'reviews/reviews', 'reviews/confirmations', 'batches', 'sessions']) await mkdir(join(root, dir), { recursive: true })
  const world = (id: string) => ({ worldId: `review-${id}`, readRoot: join(root, id), confirmedRoot: join(root, id, 'confirmed'), catalogRoot: join(root, id, 'catalog'),
    mainAgent: { agentId: 'main', writableRoot: join(root, id, 'main') }, agents: [{ agentId: 'map', writableRoot: join(root, id, 'map') }] })
  const a = world('a'); const b = world('b'); const worlds = [a, b]
  const context = new Context(); const backend = await context.plugin(LocalFileSystem, { cwd: root })
  const openMap = (value: typeof a) => MapStore.open({ fs: context.fs, root: join(value.readRoot, 'map'), worldId: value.worldId, access: 'read-write', singleWriterProcess: true })
  const mapA = await openMap(a); const mapB = await openMap(b)
  const overview = { name: '河谷', description: '', scale: { width: 100, height: 100, unit: 'km' }, layers: [{ id: 'area', name: '地区' }], orientation: '北', reserved: [] }
  await mapA.createOverview(overview); await mapB.createOverview(overview)
  const place = { name: '曲水城', aliases: [], description: '城门昼夜开放', detailLevel: 'overview' as const,
    parents: [{ layerId: 'area', parent: { kind: 'world' as const }, localBoxes: [[0, 0, 100, 100] as [number, number, number, number]], frameBox: null, coverage: 'complete' as const }], reserved: [] }
  const cityA = await mapA.createPlace(place); const cityB = await mapB.createPlace(place)
  await mapA.createPlace({ ...place, name: '商队营地', description: '商队需要夜间入城', parents: [{ ...place.parents[0]!, parent: { kind: 'place', id: cityA.id } }] })
  const targetA = { kind: 'place' as const, id: cityA.id }; const targetB = { kind: 'place' as const, id: cityB.id }
  const discussionA = await DiscussionService.open({ worldId: a.worldId, root: join(root, 'pending-a'), worldRoots: [a.readRoot, b.readRoot], fs: context.fs,
    adapter: createInitialDiscussionAdapter(a, { map: { agentId: 'map', store: mapA } }), singleWriterProcess: true })
  const discussionB = await DiscussionService.open({ worldId: b.worldId, root: join(root, 'pending-b'), worldRoots: [a.readRoot, b.readRoot], fs: context.fs,
    adapter: createInitialDiscussionAdapter(b, { map: { agentId: 'map', store: mapB } }), singleWriterProcess: true })
  const threadA = await discussionA.createDiscussion(targetA, 'city'); const threadB = await discussionB.createDiscussion(targetB, 'other-city')
  const impactA = await ImpactService.open({ workspaces: worlds, worldId: a.worldId, root: join(root, 'reports-a'), fs: context.fs, discussion: discussionA, map: { agentId: 'map', store: mapA }, singleWriterProcess: true })
  const impactB = await ImpactService.open({ workspaces: worlds, worldId: b.worldId, root: join(root, 'reports-b'), fs: context.fs, discussion: discussionB, map: { agentId: 'map', store: mapB }, singleWriterProcess: true })
  const reviews = await ReviewService.open({ workspaces: worlds, worldId: a.worldId, root: join(root, 'reviews'), fs: context.fs, discussion: discussionA, impact: impactA, singleWriterProcess: true })
  if (!(context.fs instanceof LocalFileSystem)) throw new Error('测试需要本机后端')
  const publisher = await TargetPublisher.create(a, context.fs, { map: { agentId: 'map', store: mapA } })
  const gate = WorldAccess.register([a.readRoot, join(root, 'pending-a'), join(root, 'reports-a'), join(root, 'reviews'), join(root, 'batches')])
  const batch = await BatchCommitService.open({ workspaces: worlds, worldId: a.worldId, root: join(root, 'batches'), fs: context.fs, gate,
    discussion: discussionA, impact: impactA, review: reviews, publisher, sessionRoots: [join(root, 'sessions')], singleWriterProcess: true })
  const cityDoc = (await mapA.readPlace(cityA.id)).document
  const adapter = new ReviewAdapter(formatMapDocument({ ...cityDoc, description: '夜间关闭，商队凭许可通行' }))
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'test', adapter }))
  const agent = await createWorldInitializationAgentWithWorldWorkspaces(worlds, a.worldId, undefined, { singleWriterProcess: true,
    discussion: { firstVersionComplete: true, binding: { service: discussionA, discussionId: threadA.id, impact: impactA } },
    mainSession: { sessionRoot: join(root, 'sessions'), sessionId: 'city', sessionMode: 'create' } })
  try {
    await agent.run({ prompt: '讨论城门规则' })
    const candidate = (await discussionA.listCandidates(threadA.id))[0]!
    assert.equal((await mapA.readPlace(cityA.id)).document.description, '城门昼夜开放')
    const other = await discussionB.createCandidate(threadB.id, targetB, formatMapDocument({ ...(await mapB.readPlace(cityB.id)).document, description: '其他世界' }), '其他世界')
    await assert.rejects(impactA.check(threadA.id, other.value.id))
    const reportFile = (await readdir(join(root, 'reports-a'))).find(name => name.endsWith('.json')); assert.ok(reportFile)
    const report = await impactA.read(threadA.id, reportFile.slice(0, -5))
    await assert.rejects(impactB.read(threadB.id, report.report.id))
    const source = report.report.scopes.find(item => item.name === '地图关联')!.sources[0]!
    const finding = { description: '商队夜间入城需要许可', severity: 'important' as const, evidence: [{ reportId: report.report.id, scope: '地图关联', sourceId: source.id }],
      options: [{ label: '采用许可例外', effect: '城门候选保留商队许可通行', candidateIds: [candidate.value.id], resolves: true },
        { label: '不处理', effect: '保留冲突', candidateIds: [], resolves: false }], recommendedIndex: 0 }
    const draft = await reviews.create(threadA.id, [report.report.id], { findings: [finding], dependencies: [] })
    await assert.rejects(batch.submit(threadA.id, draft.value.id, '模型声称已确认'), /不存在/)
    const uncovered = report.report.scopes.filter(scope => scope.status === 'uncovered').map(scope => ({ reportId: report.report.id, scope: scope.name }))
    const input = { reviewVersion: draft.version, confirmContinue: true as const, selectedCandidateIds: [candidate.value.id], selections: [], acknowledgedUncovered: uncovered }
    await assert.rejects(reviews.confirm(threadA.id, draft.value.id, { ...input, selections: [{ findingId: draft.value.findings[0]!.id, optionId: draft.value.findings[0]!.options[1]!.id }] }), /重要冲突/)
    await mapA.createPlace({ ...place, name: '新增范围' })
    await assert.rejects(reviews.confirm(threadA.id, draft.value.id, input), /重新检查/)
    const current = await impactA.check(threadA.id, candidate.value.id)
    const updatedFinding = { ...finding, evidence: [{ ...finding.evidence[0]!, reportId: current.report.id }] }
    const explicit = await reviews.create(threadA.id, [current.report.id], { findings: [updatedFinding], dependencies: [] })
    const ack = current.report.scopes.filter(scope => scope.status === 'uncovered').map(scope => ({ reportId: current.report.id, scope: scope.name }))
    const selected = await reviews.confirm(threadA.id, explicit.value.id, { reviewVersion: explicit.version, confirmContinue: true,
      selectedCandidateIds: [candidate.value.id], selections: [{ findingId: explicit.value.findings[0]!.id, optionId: explicit.value.findings[0]!.options[0]!.id }], acknowledgedUncovered: ack })
    assert.equal(selected.value.choices[0]!.origin, 'explicit')
    const suggested = await reviews.create(threadA.id, [current.report.id], { findings: [updatedFinding], dependencies: [] })
    const confirmed = await reviews.confirm(threadA.id, suggested.value.id, { reviewVersion: suggested.version, confirmContinue: true,
      selectedCandidateIds: [candidate.value.id], selections: [], acknowledgedUncovered: ack })
    assert.equal(confirmed.value.choices[0]!.origin, 'recommended')
    const abort = new AbortController(); abort.abort(); await assert.rejects(batch.submit(threadA.id, suggested.value.id, confirmed.version, abort.signal))
    assert.equal((await batch.submit(threadA.id, suggested.value.id, confirmed.version)).state, 'completed')
    await assert.rejects(batch.submit(threadA.id, explicit.value.id, selected.version))
    assert.equal((await mapA.readPlace(cityA.id)).document.description, '夜间关闭，商队凭许可通行')
    assert.equal((await mapB.readPlace(cityB.id)).document.description, '城门昼夜开放')
  } finally {
    await agent.dispose(); await batch.close(); await gate.close(); await reviews.close(); await impactA.close(); await impactB.close();
    await discussionA.close(); await discussionB.close(); await mapA.close(); await mapB.close(); await backend.dispose()
  }
})
