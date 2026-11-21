import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
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

test('进程在正文发布后退出，重启后按实际版本和用户选择恢复', { timeout: 30000 }, async t => {
  const temp = join(process.cwd(), 'tmp'); await mkdir(temp, { recursive: true })
  const root = await realpath(await mkdtemp(join(temp, 'batch-crash-'))); t.after(() => rm(root, { recursive: true, force: true }))
  for (const dir of ['world/main', 'world/confirmed', 'world/catalog', 'pending/discussions', 'pending/candidates', 'reports', 'reviews/reviews', 'reviews/confirmations', 'batches']) await mkdir(join(root, dir), { recursive: true })
  const view = join(root, 'world'); const pending = join(root, 'pending'); const reports = join(root, 'reports'); const reviews = join(root, 'reviews'); const batches = join(root, 'batches')
  await writeFile(join(view, 'main', 'plan.md'), '城门开放')
  const world = { worldId: 'crash-world', readRoot: view, confirmedRoot: join(view, 'confirmed'), catalogRoot: join(view, 'catalog'), mainAgent: { agentId: 'main', writableRoot: join(view, 'main') }, agents: [] }
  const base: DiscussionTargetAdapter = { async read() { throw new Error('未支持') }, async validate() { throw new Error('未支持') }, async validateStored() { throw new Error('未支持') }, async assertNoLegacyCandidate() { throw new Error('未支持') } }
  const open = async () => {
    const context = new Context(); const backend = await context.plugin(LocalFileSystem, { cwd: root })
    if (!(context.fs instanceof LocalFileSystem)) throw new Error('测试需要本机后端')
    const discussion = await DiscussionService.open({ worldId: world.worldId, root: pending, worldRoots: [view], fs: context.fs,
      adapter: withFileDiscussionAdapter(base, world, context.fs), singleWriterProcess: true })
    const impact = await ImpactService.open({ workspaces: [world], worldId: world.worldId, root: reports, fs: context.fs, discussion, singleWriterProcess: true })
    const review = await ReviewService.open({ workspaces: [world], worldId: world.worldId, root: reviews, fs: context.fs, discussion, impact, singleWriterProcess: true })
    const publisher = await TargetPublisher.create(world, context.fs, {})
    const gate = WorldAccess.register([view, pending, reports, reviews, batches])
    const batch = await BatchCommitService.open({ workspaces: [world], worldId: world.worldId, root: batches, fs: context.fs, gate, discussion, impact, review, publisher, sessionRoots: [], singleWriterProcess: true })
    return { discussion, impact, review, batch, close: async () => { await batch.close(); await gate.close(); await review.close(); await impact.close(); await discussion.close(); await backend.dispose() } }
  }
  const first = await open(); const target = { kind: 'file' as const, ownerAgentId: 'main', path: 'main/plan.md' }
  const discussion = await first.discussion.createDiscussion(target, 'session')
  const candidate = await first.discussion.createCandidate(discussion.id, target, '夜间关闭', '城门规则')
  const report = await first.impact.check(discussion.id, candidate.value.id)
  const review = await first.review.create(discussion.id, [report.report.id], { findings: [], dependencies: [] })
  const confirmation = await first.review.confirm(discussion.id, review.value.id, { reviewVersion: review.version, confirmContinue: true, selectedCandidateIds: [candidate.value.id], selections: [],
    acknowledgedUncovered: report.report.scopes.filter(scope => scope.status === 'uncovered').map(scope => ({ reportId: report.report.id, scope: scope.name })) })
  await first.close()
  const childScript = `
    const { Context } = require('@deepseek-ai/cordis'); const { LocalFileSystem } = require('@fly-novel/fs-local'); const { WorldAccess } = require('@fly-novel/util');
    const { DiscussionService } = require('./.test-dist/world-init/discussion/service.js'); const { withFileDiscussionAdapter } = require('./.test-dist/world-init/discussion/file-adapter.js');
    const { ImpactService } = require('./.test-dist/world-init/impact/service.js'); const { ReviewService } = require('./.test-dist/world-init/impact/review.js');
    const { TargetPublisher } = require('./.test-dist/world-init/impact/target-publisher.js'); const { BatchCommitService } = require('./.test-dist/world-init/impact/batch-commit.js');
    const x = JSON.parse(process.argv[1]);
    (async () => {
      const context = new Context(); await context.plugin(LocalFileSystem, { cwd: x.root });
      const base = { async read() { throw Error('unsupported') }, async validate() { throw Error('unsupported') }, async validateStored() { throw Error('unsupported') }, async assertNoLegacyCandidate() { throw Error('unsupported') } };
      const discussion = await DiscussionService.open({worldId:x.world.worldId,root:x.pending,worldRoots:[x.view],fs:context.fs,adapter:withFileDiscussionAdapter(base,x.world,context.fs),singleWriterProcess:true});
      const impact = await ImpactService.open({workspaces:[x.world],worldId:x.world.worldId,root:x.reports,fs:context.fs,discussion,singleWriterProcess:true});
      const review = await ReviewService.open({workspaces:[x.world],worldId:x.world.worldId,root:x.reviews,fs:context.fs,discussion,impact,singleWriterProcess:true});
      const publisher = await TargetPublisher.create(x.world,context.fs,{}); const gate = WorldAccess.register([x.view,x.pending,x.reports,x.reviews,x.batches]);
      const batch = await BatchCommitService.open({workspaces:[x.world],worldId:x.world.worldId,root:x.batches,fs:context.fs,gate,discussion,impact,review,publisher,sessionRoots:[],singleWriterProcess:true});
      const publish = publisher.publish.bind(publisher); publisher.publish = async (...args) => { await publish(...args); process.exit(77) };
      await batch.submit(x.discussionId,x.reviewId,x.confirmationVersion); process.exit(2);
    })().catch(error => { process.stderr.write(String(error)); process.exit(3) });`
  const input = JSON.stringify({ root, world, view, pending, reports, reviews, batches, discussionId: discussion.id, reviewId: review.value.id, confirmationVersion: confirmation.version })
  const childResult = await new Promise<{ code: number | null; error: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', childScript, input], { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe'] })
    let error = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { error += String(chunk) })
    const timer = setTimeout(() => child.kill(), 20000)
    child.once('error', cause => { clearTimeout(timer); reject(cause) }); child.once('exit', code => { clearTimeout(timer); resolve({ code, error }) })
  })
  assert.equal(childResult.code, 77, childResult.error)
  const reopened = await open()
  try {
    assert.equal(await readFile(join(view, 'main', 'plan.md'), 'utf8'), '夜间关闭')
    assert.equal((await reopened.batch.inspect(review.value.id)).value.items[0]!.phase, 'publishing')
    assert.equal((await reopened.discussion.readCandidate(candidate.value.id)).value.status, 'publishing')
    await reopened.batch.stopAfterInterrupt(review.value.id)
    await assert.rejects(reopened.batch.reconcileItem(review.value.id, candidate.value.id), /需用户核查/)
    const observed = await reopened.discussion.readRelated(discussion.id, target)
    const result = await reopened.batch.reconcileItem(review.value.id, candidate.value.id, { kind: 'accept-result', observedVersion: observed.version })
    assert.equal(result.state, 'stopped'); assert.equal(result.items[0]!.phase, 'committed')
  } finally { await reopened.close() }
})
