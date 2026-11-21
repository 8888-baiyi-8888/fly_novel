import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@fly-novel/fs-local'
import { openWorldInitializationWorkflow } from '../../app/world-initialization-entry.js'
import { withFileDiscussionAdapter } from '../discussion/file-adapter.js'
import { candidateSchema, type DiscussionTargetAdapter } from '../discussion/service.js'

test('真实模型在隔离世界讨论、发布并保存最终交付', { skip: process.env.FLY_NOVEL_REAL_LLM_TEST !== '1', timeout: 300000 }, async t => {
  const temp = join(process.cwd(), 'tmp'); await mkdir(temp, { recursive: true })
  const root = await realpath(await mkdtemp(join(temp, 'init-delivery-real-'))); t.diagnostic(`隔离测试目录：${root}`)
  const view = join(root, 'world')
  for (const dir of ['world/main', 'world/confirmed', 'world/catalog', 'discussion/discussions', 'discussion/candidates', 'impact',
    'review/reviews', 'review/confirmations', 'commit', 'batch', 'task/tasks', 'task/first-versions', 'delivery/reviews', 'delivery/deliveries', 'session']) await mkdir(join(root, dir), { recursive: true })
  await writeFile(join(view, 'main', 'city.md'), '曲水城城门昼夜开放。')
  const world = { worldId: 'delivery-real', readRoot: view, confirmedRoot: join(view, 'confirmed'), catalogRoot: join(view, 'catalog'),
    mainAgent: { agentId: 'main', writableRoot: join(view, 'main') }, agents: [] }
  const context = new Context(); const backend = await context.plugin(LocalFileSystem, { cwd: root })
  if (!(context.fs instanceof LocalFileSystem)) throw new Error('测试需要本机后端')
  const base: DiscussionTargetAdapter = { async read() { throw new Error('未支持') }, async validate() {}, async validateStored() {}, async assertNoLegacyCandidate() {} }
  const adapter = withFileDiscussionAdapter(base, world, context.fs)
  const roots = { task: join(root, 'task'), discussion: join(root, 'discussion'), impact: join(root, 'impact'), review: join(root, 'review'),
    commit: join(root, 'commit'), batch: join(root, 'batch'), delivery: join(root, 'delivery') }
  const opened = await openWorldInitializationWorkflow({ worlds: [world], worldId: world.worldId, roots, sessionRoots: [join(root, 'session')],
    fs: context.fs, adapter, publisher: {}, singleWriterProcess: true })
  try {
    const workflow = opened.workflow; const target = { kind: 'file' as const, ownerAgentId: 'main', path: 'main/city.md' }
    const taskId = randomUUID(); const firstId = randomUUID(); const now = new Date().toISOString()
    await workflow.createTask({ id: taskId, sessionIds: ['city'], createdAt: now })
    await workflow.confirmFirstVersion({ id: firstId, taskId, createdAt: now, actor: 'user', scope: '虚构城门资料', artifacts: [{ target, version: (await adapter.read(target)).version }] })
    const discussion = await workflow.createDiscussion({ taskId, judgmentId: firstId, sessionId: 'city', target })
    const agent = await workflow.startAgentForTask({ taskId, judgmentId: firstId, discussionId: discussion.id, options: { mainMaxSteps: 20 },
      session: { sessionRoot: join(root, 'session'), sessionId: 'city', sessionMode: 'create' } })
    const timeout = setTimeout(() => agent.cancel(), 240000)
    try { assert.ok((await agent.run({ prompt: '请读取已选曲水城资料，改为城门夜间关闭，并用 discussion_prepare 保存完整待审正文；不要修改当前资料。' })).content.trim()) }
    finally { clearTimeout(timeout) }
    const candidates = (await workflow.discover()).entries.filter(entry => entry.kind === 'candidate' && entry.status === 'valid')
    assert.equal(candidates.length, 1, '模型没有保存唯一候选')
    const candidate = candidateSchema.parse(candidates[0]!.record); assert.equal(candidate.status, 'active'); assert.match(candidate.content, /关闭/)
    assert.equal(await readFile(join(view, 'main', 'city.md'), 'utf8'), '曲水城城门昼夜开放。')
    const report = await workflow.checkImpact(taskId, discussion.id, candidate.id)
    const review = await workflow.createReview(taskId, discussion.id, [report.report.id], { findings: [], dependencies: [] })
    const uncovered = report.report.scopes.filter(scope => scope.status === 'uncovered').map(scope => ({ reportId: report.report.id, scope: scope.name }))
    const confirmed = await workflow.confirmReview(taskId, discussion.id, review.value.id, { reviewVersion: review.version, confirmContinue: true,
      selectedCandidateIds: [candidate.id], selections: [], acknowledgedUncovered: uncovered })
    assert.equal((await workflow.submit(taskId, discussion.id, review.value.id, confirmed.version)).state, 'completed')
    const freshId = randomUUID()
    await workflow.confirmFirstVersion({ id: freshId, taskId, createdAt: now, actor: 'user', scope: '虚构城门资料', artifacts: [{ target, version: (await adapter.read(target)).version }] })
    const finalReview = await workflow.prepareDelivery({ id: randomUUID(), taskId, judgmentId: freshId, createdAt: now, targets: [target], reportIds: [], notes: ['隔离合成样例'] })
    const done = await workflow.completeDelivery({ id: randomUUID(), taskId, reviewId: finalReview.value.id, reviewVersion: finalReview.version,
      createdAt: now, confirm: true, deferredCandidateIds: [], acknowledgedUncovered: finalReview.value.uncovered })
    assert.equal(done.value.review.artifacts[0]?.content, candidate.content)
    t.diagnostic('程序断言覆盖真实模型候选、可信发布和交付快照；正文质量和留白需人工审阅。')
  } finally { await opened.close(); await backend.dispose() }
})
