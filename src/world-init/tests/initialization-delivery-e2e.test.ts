import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@fly-novel/fs-local'
import { LlmAdapter, type GenerateOptions, type StreamChunk, type ToolCallId } from '@fly-novel/llm'
import configured = require('../../app/call-llm.js')
import { openWorldInitializationWorkflow } from '../../app/world-initialization-entry.js'
import { withFileDiscussionAdapter } from '../discussion/file-adapter.js'
import { candidateSchema, type DiscussionTargetAdapter } from '../discussion/service.js'

class ScriptedAdapter extends LlmAdapter {
  private calls = 0
  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (this.calls++ === 0) {
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'candidate' as ToolCallId, name: 'discussion_prepare',
        arguments: JSON.stringify({ content: '城门夜间关闭', summary: '调整城门' }) } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '待审候选已保存' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

test('双世界从第一版、讨论、确认发布到交付及重启读取', { timeout: 30000 }, async t => {
  const temp = join(process.cwd(), 'tmp'); await mkdir(temp, { recursive: true })
  const root = await realpath(await mkdtemp(join(temp, 'init-full-')))
  const contexts = new Context(); const backend = await contexts.plugin(LocalFileSystem, { cwd: root })
  t.after(async () => { await backend.dispose(); await rm(root, { recursive: true, force: true }) })
  if (!(contexts.fs instanceof LocalFileSystem)) throw new Error('测试需要本机后端')
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'fixed', adapter: new ScriptedAdapter() }))
  const names = ['甲世界', '乙世界']; const configs = []
  for (const name of names) {
    const base = join(root, name); const view = join(base, 'world')
    for (const dir of ['world/main', 'world/confirmed', 'world/catalog', 'discussion/discussions', 'discussion/candidates', 'impact',
      'review/reviews', 'review/confirmations', 'commit', 'batch', 'task/tasks', 'task/first-versions', 'delivery/reviews', 'delivery/deliveries', 'session']) await mkdir(join(base, dir), { recursive: true })
    await writeFile(join(view, 'main', 'city.md'), '城门全天开放')
    configs.push({ world: { worldId: name, readRoot: view, confirmedRoot: join(view, 'confirmed'), catalogRoot: join(view, 'catalog'),
      mainAgent: { agentId: 'main', writableRoot: join(view, 'main') }, agents: [] }, base })
  }
  const worlds = configs.map(item => item.world)
  const baseAdapter: DiscussionTargetAdapter = { async read() { throw new Error('未支持') }, async validate() {}, async validateStored() {}, async assertNoLegacyCandidate() {} }
  const target = { kind: 'file' as const, ownerAgentId: 'main', path: 'main/city.md' }
  for (const { world, base } of configs) {
    const roots = { task: join(base, 'task'), discussion: join(base, 'discussion'), impact: join(base, 'impact'), review: join(base, 'review'),
      commit: join(base, 'commit'), batch: join(base, 'batch'), delivery: join(base, 'delivery') }
    const adapter = withFileDiscussionAdapter(baseAdapter, world, contexts.fs)
    const options = { worlds, worldId: world.worldId, roots, sessionRoots: [join(base, 'session')], fs: contexts.fs,
      adapter, publisher: {}, singleWriterProcess: true as const }
    let opened = await openWorldInitializationWorkflow(options); const workflow = opened.workflow
    const taskId = randomUUID(); const firstId = randomUUID(); const now = new Date().toISOString()
    await workflow.createTask({ id: taskId, sessionIds: ['city'], createdAt: now })
    await workflow.confirmFirstVersion({ id: firstId, taskId, createdAt: now, actor: 'user', scope: '城门资料', artifacts: [{ target, version: (await adapter.read(target)).version }] })
    const discussion = await workflow.createDiscussion({ taskId, judgmentId: firstId, sessionId: 'city', target })
    const agent = await workflow.startAgentForTask({ taskId, judgmentId: firstId, discussionId: discussion.id,
      session: { sessionRoot: join(base, 'session'), sessionId: 'city', sessionMode: 'create' } })
    assert.ok((await agent.run({ prompt: '请准备城门修改候选' })).content)
    const discovered = await workflow.discover()
    const candidate = candidateSchema.parse(discovered.entries.find(entry => entry.kind === 'candidate' && entry.status === 'valid')?.record)
    assert.equal(candidate.status, 'active')
    assert.equal(await readFile(join(world.readRoot, 'main', 'city.md'), 'utf8'), '城门全天开放')
    const report = await workflow.checkImpact(taskId, discussion.id, candidate.id)
    const draft = await workflow.createReview(taskId, discussion.id, [report.report.id], { findings: [], dependencies: [] })
    const uncovered = report.report.scopes.filter(scope => scope.status === 'uncovered').map(scope => ({ reportId: report.report.id, scope: scope.name }))
    const confirmation = await workflow.confirmReview(taskId, discussion.id, draft.value.id, { reviewVersion: draft.version, confirmContinue: true,
      selectedCandidateIds: [candidate.id], selections: [], acknowledgedUncovered: uncovered })
    const published = await workflow.submit(taskId, discussion.id, draft.value.id, confirmation.version)
    assert.equal(published.state, 'completed')
    assert.equal(await readFile(join(world.readRoot, 'main', 'city.md'), 'utf8'), '城门夜间关闭')
    const freshId = randomUUID()
    await workflow.confirmFirstVersion({ id: freshId, taskId, createdAt: now, actor: 'user', scope: '城门资料', artifacts: [{ target, version: (await adapter.read(target)).version }] })
    const finalReview = await workflow.prepareDelivery({ id: randomUUID(), taskId, judgmentId: freshId, createdAt: now, targets: [target], reportIds: [], notes: [] })
    const done = await workflow.completeDelivery({ id: randomUUID(), taskId, reviewId: finalReview.value.id, reviewVersion: finalReview.version,
      createdAt: now, confirm: true, deferredCandidateIds: [], acknowledgedUncovered: finalReview.value.uncovered })
    if (world.worldId === names[0]) assert.equal(await readFile(join(configs[1]!.world.readRoot, 'main', 'city.md'), 'utf8'), '城门全天开放')
    const interruptedReview = await workflow.prepareDelivery({ id: randomUUID(), taskId, judgmentId: freshId, createdAt: now, targets: [target], reportIds: [], notes: ['进程中断样例'] })
    const interruptedInput = { id: randomUUID(), taskId, reviewId: interruptedReview.value.id, reviewVersion: interruptedReview.version,
      createdAt: now, confirm: true as const, deferredCandidateIds: [], acknowledgedUncovered: interruptedReview.value.uncovered }
    await opened.close()
    if (world.worldId === names[0]) {
      const script = `
        const { Context } = require('@deepseek-ai/cordis'); const { LocalFileSystem } = require('@fly-novel/fs-local');
        const { openWorldInitializationWorkflow } = require('./.test-dist/app/world-initialization-entry.js');
        const { withFileDiscussionAdapter } = require('./.test-dist/world-init/discussion/file-adapter.js');
        const x = JSON.parse(process.argv[1]);
        (async () => {
          const ctx = new Context(); await ctx.plugin(LocalFileSystem, {cwd:x.root});
          const base = {async read(){throw Error('unsupported')},async validate(){},async validateStored(){},async assertNoLegacyCandidate(){}};
          const adapter = withFileDiscussionAdapter(base,x.world,ctx.fs);
          const app = await openWorldInitializationWorkflow({worlds:x.worlds,worldId:x.world.worldId,roots:x.roots,sessionRoots:x.sessions,fs:ctx.fs,adapter,publisher:{},singleWriterProcess:true});
          const write = ctx.fs.writeText.bind(ctx.fs); ctx.fs.writeText = async (...args) => {await write(...args);process.exit(78)};
          await app.workflow.completeDelivery(x.input); process.exit(2);
        })().catch(error => {process.stderr.write(String(error));process.exit(3)});`
      const childInput = JSON.stringify({ root, world, worlds, roots, sessions: [join(base, 'session')], input: interruptedInput })
      const result = await new Promise<{ code: number | null; error: string }>((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', script, childInput], { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe'] })
        let error = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { error += String(chunk) })
        const timer = setTimeout(() => child.kill(), 20000)
        child.once('error', cause => { clearTimeout(timer); reject(cause) }); child.once('exit', code => { clearTimeout(timer); resolve({ code, error }) })
      })
      assert.equal(result.code, 78, result.error)
    }
    opened = await openWorldInitializationWorkflow(options)
    if (world.worldId === names[0]) assert.equal((await opened.workflow.completeDelivery(interruptedInput)).value.id, interruptedInput.id)
    assert.equal((await opened.workflow.readDelivery(done.value.id)).value.review.artifacts[0]?.content, '城门夜间关闭')
    await opened.close()
  }
  assert.equal(await readFile(join(configs[0]!.world.readRoot, 'main', 'city.md'), 'utf8'), '城门夜间关闭')
  assert.equal(await readFile(join(configs[1]!.world.readRoot, 'main', 'city.md'), 'utf8'), '城门夜间关闭')
})
