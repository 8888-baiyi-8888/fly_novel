import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@fly-novel/fs-local'
import { WorldAccess } from '@fly-novel/util'
import { DiscussionService, type DiscussionTargetAdapter } from '../discussion/service.js'
import { withFileDiscussionAdapter } from '../discussion/file-adapter.js'
import { ImpactService } from '../impact/service.js'
import { ReviewService } from '../impact/review.js'
import { TargetPublisher } from '../impact/target-publisher.js'
import { BatchCommitService } from '../impact/batch-commit.js'
import { InitializationTaskStore } from '../recovery/task-store.js'
import { InitializationRecovery } from '../recovery/orchestrator.js'

test('恢复先展示现状，过期记录被拒绝，中断批次不继续发布', async t => {
  const temp = join(process.cwd(), 'tmp'); await mkdir(temp, { recursive: true })
  const root = await realpath(await mkdtemp(join(temp, 'init-recovery-')))
  for (const dir of ['world/main', 'world/confirmed', 'world/catalog', 'pending/discussions', 'pending/candidates', 'reports', 'reviews/reviews', 'reviews/confirmations', 'batches', 'tasks/tasks', 'tasks/first-versions']) await mkdir(join(root, dir), { recursive: true })
  const view = join(root, 'world'); const pending = join(root, 'pending'); const reports = join(root, 'reports'); const reviews = join(root, 'reviews'); const batches = join(root, 'batches'); const taskRoot = join(root, 'tasks')
  await writeFile(join(view, 'main', 'plan.md'), '城门开放')
  const world = { worldId: 'recovery-world', readRoot: view, confirmedRoot: join(view, 'confirmed'), catalogRoot: join(view, 'catalog'), mainAgent: { agentId: 'main', writableRoot: join(view, 'main') }, agents: [] }
  const context = new Context(); const backend = await context.plugin(LocalFileSystem, { cwd: root })
  if (!(context.fs instanceof LocalFileSystem)) throw new Error('测试需要本机后端')
  const base: DiscussionTargetAdapter = { async read() { throw new Error('未支持') }, async validate() {}, async validateStored() {}, async assertNoLegacyCandidate() {} }
  const adapter = withFileDiscussionAdapter(base, world, context.fs)
  const discussion = await DiscussionService.open({ worldId: world.worldId, root: pending, worldRoots: [view], fs: context.fs, adapter, singleWriterProcess: true })
  const target = { kind: 'file' as const, ownerAgentId: 'main', path: 'main/plan.md' }
  const d = await discussion.createDiscussion(target, 'session'); const candidate = await discussion.createCandidate(d.id, target, '城门关闭', '关闭城门')
  const impact = await ImpactService.open({ workspaces: [world], worldId: world.worldId, root: reports, fs: context.fs, discussion, singleWriterProcess: true })
  const review = await ReviewService.open({ workspaces: [world], worldId: world.worldId, root: reviews, fs: context.fs, discussion, impact, singleWriterProcess: true })
  const publisher = await TargetPublisher.create(world, context.fs, {})
  const gate = WorldAccess.register([view, pending, reports, reviews, batches, taskRoot])
  const batch = await BatchCommitService.open({ workspaces: [world], worldId: world.worldId, root: batches, fs: context.fs, gate, discussion, impact, review, publisher, sessionRoots: [], singleWriterProcess: true })
  const tasks = await InitializationTaskStore.open({ worlds: [world], worldId: world.worldId, root: taskRoot, otherRoots: [pending, reports, reviews, batches], fs: context.fs, gate, adapter, singleWriterProcess: true })
  t.after(async () => { await tasks.close(); await batch.close(); await gate.close(); await review.close(); await impact.close(); await discussion.close(); await backend.dispose(); await rm(root, { recursive: true, force: true }) })
  const recovery = await InitializationRecovery.create({ worlds: [world], worldId: world.worldId, gate, discussions: discussion, tasks, batch })
  const operationId = randomUUID(); const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  const operation = { formatVersion: 1, id: operationId, worldId: world.worldId, discussionId: d.id, reviewVersion: 'r', confirmationVersion: 'c', state: 'running', error: null,
    items: [{ candidateId: candidate.value.id, candidateVersion: candidate.version, reportId: randomUUID(), reportVersion: 'v', target, baseline: candidate.value.baseline,
      beforeDigest: hash('城门开放'), afterDigest: hash('城门关闭'), afterVersion: null, phase: 'ready', catalogStatus: 'pending', catalogError: null, recoveryDecision: null }] }
  await writeFile(join(batches, `${operationId}.json`), JSON.stringify(operation))
  const preview = await recovery.inspectBatch(operationId)
  assert.equal(preview.items[0]?.observed.current.status, 'read')
  assert.equal(preview.items[0]?.observed.candidate.status, 'read')
  await assert.rejects(recovery.stopBatch({ id: operationId, expectedVersion: 'stale' }), /已变化/)
  assert.equal((await batch.inspect(operationId)).value.state, 'running')
  assert.equal((await recovery.stopBatch({ id: operationId, expectedVersion: preview.record.version })).state, 'stopped')
  const stopped = await recovery.inspectBatch(operationId)
  assert.equal(stopped.items[0]?.phase, 'ready')
  assert.equal((await recovery.reconcileBatchItem({ id: operationId, candidateId: candidate.value.id, expectedVersion: stopped.record.version })).items[0]?.phase, 'ready')
  assert.equal((await recovery.reconcileBatchItem({ id: operationId, candidateId: candidate.value.id, expectedVersion: stopped.record.version })).items[0]?.phase, 'ready')
  const uncertainId = randomUUID()
  await writeFile(join(batches, `${uncertainId}.json`), JSON.stringify({ ...operation, id: uncertainId, state: 'stopped', items: [{ ...operation.items[0], phase: 'publishing' }] }))
  await writeFile(join(view, 'main', 'plan.md'), '后续修改')
  const uncertain = await recovery.inspectBatch(uncertainId)
  await assert.rejects(recovery.reconcileBatchItem({ id: uncertainId, candidateId: candidate.value.id, expectedVersion: uncertain.record.version }), /正文已变化/)
  assert.equal((await batch.inspect(uncertainId)).value.items[0]?.phase, 'publishing')
  assert.equal((await discussion.readCandidate(candidate.value.id)).value.status, 'active')
})
