import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@fly-novel/fs-local'
import { MapStore, parseMapPlace } from '@fly-novel/map'
import { WorldAccess } from '@fly-novel/util'
import { createWorldInitializationAgentWithWorldWorkspaces } from '../agents/index.js'
import { DiscussionService } from '../../world-init/discussion/service.js'
import { createInitialDiscussionAdapter } from '../../world-init/discussion/initial-adapters.js'
import { ImpactService } from '../../world-init/impact/service.js'
import { ReviewService } from '../../world-init/impact/review.js'
import { TargetPublisher } from '../../world-init/impact/target-publisher.js'
import { BatchCommitService } from '../../world-init/impact/batch-commit.js'

test('真实模型生成地点候选并检查，可信测试应用审阅后发布', { skip: process.env.FLY_NOVEL_REAL_LLM_TEST !== '1', timeout: 540000 }, async t => {
  const temp = join(process.cwd(), 'tmp'); await mkdir(temp, { recursive: true })
  const root = await realpath(await mkdtemp(join(temp, 'review-real-'))); t.diagnostic(`隔离测试目录：${root}`)
  for (const dir of ['world/main', 'world/confirmed', 'world/catalog', 'world/map/places', 'world/map/connections', 'pending/discussions', 'pending/candidates', 'sessions', 'reports', 'reviews/reviews', 'reviews/confirmations', 'batches']) await mkdir(join(root, dir), { recursive: true })
  const view = join(root, 'world'); const sessions = join(root, 'sessions'); const pending = join(root, 'pending'); const reports = join(root, 'reports'); const reviews = join(root, 'reviews'); const batches = join(root, 'batches')
  const world = { worldId: 'review-real', readRoot: view, confirmedRoot: join(view, 'confirmed'), catalogRoot: join(view, 'catalog'),
    mainAgent: { agentId: 'main', writableRoot: join(view, 'main') }, agents: [{ agentId: 'map', writableRoot: join(view, 'map') }] }
  const context = new Context(); const backend = await context.plugin(LocalFileSystem, { cwd: root })
  const map = await MapStore.open({ fs: context.fs, root: join(view, 'map'), worldId: world.worldId, access: 'read-write', singleWriterProcess: true })
  await map.createOverview({ name: '河谷', description: '', scale: { width: 100, height: 100, unit: 'km' }, layers: [{ id: 'area', name: '地区' }], orientation: '北', reserved: [] })
  const city = await map.createPlace({ name: '曲水城', aliases: [], description: '城门昼夜开放。', detailLevel: 'overview',
    parents: [{ layerId: 'area', parent: { kind: 'world' }, localBoxes: [[0, 0, 100, 100]], frameBox: null, coverage: 'complete' }], reserved: [] })
  const discussion = await DiscussionService.open({ worldId: world.worldId, root: pending, worldRoots: [view], fs: context.fs,
    adapter: createInitialDiscussionAdapter(world, { map: { agentId: 'map', store: map } }), singleWriterProcess: true })
  const record = await discussion.createDiscussion({ kind: 'place', id: city.id }, 'city')
  const impact = await ImpactService.open({ workspaces: [world], worldId: world.worldId, root: reports, fs: context.fs, discussion, map: { agentId: 'map', store: map }, singleWriterProcess: true })
  const review = await ReviewService.open({ workspaces: [world], worldId: world.worldId, root: reviews, fs: context.fs, discussion, impact, singleWriterProcess: true })
  if (!(context.fs instanceof LocalFileSystem)) throw new Error('测试需要本机后端')
  const publisher = await TargetPublisher.create(world, context.fs, { map: { agentId: 'map', store: map } })
  const gate = WorldAccess.register([view, pending, reports, reviews, batches])
  const batch = await BatchCommitService.open({ workspaces: [world], worldId: world.worldId, root: batches, fs: context.fs, gate, discussion, impact, review, publisher, sessionRoots: [sessions], singleWriterProcess: true })
  const agent = await createWorldInitializationAgentWithWorldWorkspaces([world], world.worldId, undefined, { singleWriterProcess: true,
    mainMaxSteps: 20, discussion: { firstVersionComplete: true, binding: { service: discussion, discussionId: record.id, impact } },
    mainSession: { sessionRoot: sessions, sessionId: 'city', sessionMode: 'create' } })
  const timeout = setTimeout(() => agent.cancel(), 360000)
  try {
    const response = await agent.run({ prompt: '请读取选中的曲水城，将城门规则改为夜间关闭、商队凭许可可通行；调用 discussion_prepare 保存完整 JSON 候选。接着用返回的候选 ID 调用 impact_check 检查，最后如实报告检查范围和未覆盖范围。不要声称用户已确认。' })
    const candidates = await discussion.listCandidates(record.id); assert.equal(candidates.length, 1, '模型未保存候选')
    const candidate = candidates[0]!; const proposed = parseMapPlace(candidate.value.content)
    assert.match(proposed.description, /关闭/); assert.match(proposed.description, /商队/)
    const reportFiles = (await readdir(reports)).filter(name => name.endsWith('.json')); assert.ok(reportFiles.length, '模型未调用影响检查')
    const checkedReports = await Promise.all(reportFiles.map(name => impact.read(record.id, name.slice(0, -5))))
    const checked = checkedReports.find(item => item.report.candidateId === candidate.value.id && item.report.candidateVersion === candidate.version)
    assert.ok(checked, '模型未检查当前候选版本')
    const current = (await map.readPlace(city.id)).document
    assert.equal(current.description, '城门昼夜开放。')
    assert.deepEqual({ ...proposed, description: current.description }, current)
    const draft = await review.create(record.id, [checked.report.id], { findings: [], dependencies: [] })
    const confirmation = await review.confirm(record.id, draft.value.id, { reviewVersion: draft.version, confirmContinue: true,
      selectedCandidateIds: [candidate.value.id], selections: [], acknowledgedUncovered: checked.report.scopes.filter(scope => scope.status === 'uncovered').map(scope => ({ reportId: checked.report.id, scope: scope.name })) })
    const published = await batch.submit(record.id, draft.value.id, confirmation.version)
    assert.equal(published.state, 'completed'); assert.deepEqual((await map.readPlace(city.id)).document, proposed)
    t.diagnostic(`真实模型答复：${response.content}`)
    t.diagnostic('确认动作由隔离测试代码模拟；未进行人工语义审阅。报告和 Session 保留在隔离测试目录。')
  } finally { clearTimeout(timeout); await agent.dispose(); await batch.close(); await gate.close(); await review.close(); await impact.close(); await discussion.close(); await map.close(); await backend.dispose() }
})
