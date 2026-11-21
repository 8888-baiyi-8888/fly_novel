import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { LlmAdapter, type GenerateOptions, type StreamChunk, type ToolCallId } from '@fly-novel/llm'
import configured = require('../../app/call-llm.js')
import { jsonlSessionPersistencePlugin } from '@fly-novel/agents'
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
import { openWorldInitializationWorkflow } from '../../app/world-initialization-entry.js'
import { WorldInitializationWorkflow } from '../../app/world-initialization-workflow.js'
import { mainSessionPersistenceId } from '../recovery/main-session-id.js'
import { InitializationRecovery } from '../recovery/orchestrator.js'

class FixedAdapter extends LlmAdapter {
  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '已了解' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

test('恢复先展示现状，过期记录被拒绝，中断批次不继续发布', async t => {
  const temp = join(process.cwd(), 'tmp'); await mkdir(temp, { recursive: true })
  const root = await realpath(await mkdtemp(join(temp, 'init-recovery-')))
  for (const dir of ['world/main', 'world/confirmed', 'world/catalog', 'pending/discussions', 'pending/candidates', 'reports', 'reviews/reviews', 'reviews/confirmations', 'batches', 'tasks/tasks', 'tasks/first-versions', 'session']) await mkdir(join(root, dir), { recursive: true })
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
  const tasks = await InitializationTaskStore.open({ worlds: [world], worldId: world.worldId, root: taskRoot, otherRoots: [pending, reports, reviews, batches, join(root, 'session')], fs: context.fs, gate, adapter, singleWriterProcess: true })
  t.after(async () => { await tasks.close(); await batch.close(); await gate.close(); await review.close(); await impact.close(); await discussion.close(); await sessionBackend.dispose(); await backend.dispose(); await rm(root, { recursive: true, force: true }) })
  const sessionBackend = await context.plugin(jsonlSessionPersistencePlugin, { root: join(root, 'session') })
  const sessionId = mainSessionPersistenceId(world.worldId, world.mainAgent.agentId, 'session', 'discussion')
  const writer = await context.sessionPersistence.create({ id: sessionId, createdAt: new Date().toISOString() }); await writer.close()
  const recovery = await InitializationRecovery.create({ worlds: [world], worldId: world.worldId, gate, discussions: discussion, tasks, batch, sessions: context.sessionPersistence })
  const workflow = await WorldInitializationWorkflow.create({ worlds: [world], worldId: world.worldId,
    roots: { task: taskRoot, discussion: pending, impact: reports, review: reviews, batch: batches }, sessionRoots: [join(root, 'session')],
    gate, tasks, discussions: discussion, impact, review, batch, recovery })
  const taskId = randomUUID(); const judgmentId = randomUUID(); const time = new Date().toISOString()
  await workflow.createTask({ id: taskId, sessionIds: ['session', 'session-2'], createdAt: time })
  const readSession = await recovery.openSession(taskId, 'session', 'discussion')
  assert.equal(readSession.id, sessionId); await readSession.close()
  await assert.rejects(recovery.openSession(taskId, 'foreign', 'discussion'), /不属于/)
  const current = await adapter.read(target)
  await workflow.confirmFirstVersion({ id: judgmentId, taskId, createdAt: time, actor: 'user', scope: '城门资料', artifacts: [{ target, version: current.version }] })
  const second = await workflow.createDiscussion({ taskId, judgmentId, sessionId: 'session-2', target })
  assert.equal(second.sessionId, 'session-2')
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'fixed', adapter: new FixedAdapter() }))
  const agent = await workflow.startAgentForTask({ taskId, judgmentId, discussionId: second.id, session: { sessionRoot: join(root, 'session'), sessionId: 'session-2', sessionMode: 'create' } })
  assert.equal((await agent.run({ prompt: '讨论城门' })).content, '已了解')
  const attempted = await agent.context.tools.execute({ calls: [{ type: 'tool-call', id: 'write-test' as ToolCallId, name: 'write', arguments: JSON.stringify({ file_path: 'main/plan.md', content: '覆盖' }) }],
    workingDirectory: view, session: agent.context.sessions.list()[0]!, signal: new AbortController().signal })
  assert.equal(attempted.results[0]?.result.isError, true)
  await assert.rejects(workflow.createDiscussion({ taskId, judgmentId, sessionId: 'foreign', target }), /不属于/)
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
  await assert.rejects(workflow.createDiscussion({ taskId, judgmentId, sessionId: 'session', target }), /依据已变化/ )
  await workflow.close()
})

test('正式应用装配失败后清理已打开服务，重新装配并关闭', async t => {
  const temp = join(process.cwd(), 'tmp'); await mkdir(temp, { recursive: true })
  const root = await realpath(await mkdtemp(join(temp, 'init-entry-')))
  const view = join(root, 'world')
  for (const dir of ['world/main', 'world/confirmed', 'world/catalog', 'pending/discussions', 'pending/candidates', 'reports', 'reviews/reviews', 'reviews/confirmations', 'commits', 'batches', 'tasks/tasks', 'session']) await mkdir(join(root, dir), { recursive: true })
  const world = { worldId: 'entry-world', readRoot: view, confirmedRoot: join(view, 'confirmed'), catalogRoot: join(view, 'catalog'), mainAgent: { agentId: 'main', writableRoot: join(view, 'main') }, agents: [] }
  const context = new Context(); const backend = await context.plugin(LocalFileSystem, { cwd: root })
  t.after(async () => { await backend.dispose(); await rm(root, { recursive: true, force: true }) })
  if (!(context.fs instanceof LocalFileSystem)) throw new Error('测试需要本机后端')
  const base: DiscussionTargetAdapter = { async read() { throw new Error('未支持') }, async validate() {}, async validateStored() {}, async assertNoLegacyCandidate() {} }
  const adapter = withFileDiscussionAdapter(base, world, context.fs)
  const roots = { task: join(root, 'tasks'), discussion: join(root, 'pending'), impact: join(root, 'reports'), review: join(root, 'reviews'), commit: join(root, 'commits'), batch: join(root, 'batches') }
  const options = { worlds: [world], worldId: world.worldId, roots, sessionRoots: [join(root, 'session')], fs: context.fs, adapter, publisher: {}, singleWriterProcess: true as const }
  await assert.rejects(openWorldInitializationWorkflow(options))
  await mkdir(join(root, 'tasks', 'first-versions'))
  const opened = await openWorldInitializationWorkflow(options)
  const taskId = randomUUID(); await opened.workflow.createTask({ id: taskId, sessionIds: [], createdAt: new Date().toISOString() })
  assert.equal((await opened.workflow.discover()).entries.some(item => item.kind === 'task' && item.status === 'valid'), true)
  await opened.close(); await opened.close()
  assert.throws(() => opened.workflow.createTask({ id: randomUUID(), sessionIds: [], createdAt: new Date().toISOString() }), /关闭/)
})
