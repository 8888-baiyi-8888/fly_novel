import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@fly-novel/fs-local'
import { MapStore } from '@fly-novel/map'
import { CharacterStore } from '@fly-novel/character'
import { bindStoryCharacters, selectStoryCharacters, type CharacterKnowledgeGrant } from '../../app/story-workflow.js'
import { LlmAdapter, type GenerateOptions, type StreamChunk, type ToolCallId } from '@fly-novel/llm'
import configured = require('../../app/call-llm.js')
import { openWorldInitializationWorkflow } from '../../app/world-initialization-entry.js'
import { bindStoryWorld, continueStoryTree, createStoryPlan, createStoryScene, createStorySceneWithMap, inspectStoryMapScene, inspectStoryProgress, prepareStoryWorldInput, readStoryMapCheck, readStoryMapProposal, readStoryPlan, readStoryRoundResult, readStoryScene, readStorySceneWorldEvidence, requestStoryMapProposal, runStoryTree } from '../../app/story-workflow.js'
import { achieved, advance, leaf, report as directorReport, ScriptedAdapter as DirectorAdapter, simulation, task } from '../../story-workflow/tests/fixtures.js'
import { CatalogService } from '../workspace/catalog/service.js'
import { initializeCatalog } from '../workspace/catalog/format.js'
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
    for (const dir of ['world/main', 'world/characters', 'world/map/places', 'world/map/connections', 'world/confirmed', 'world/catalog', 'discussion/discussions', 'discussion/candidates', 'impact',
      'review/reviews', 'review/confirmations', 'commit', 'batch', 'task/tasks', 'task/first-versions', 'delivery/reviews', 'delivery/deliveries', 'session']) await mkdir(join(base, dir), { recursive: true })
    await writeFile(join(view, 'main', 'city.md'), '城门全天开放')
    configs.push({ world: { worldId: name, readRoot: view, confirmedRoot: join(view, 'confirmed'), catalogRoot: join(view, 'catalog'),
      mainAgent: { agentId: 'main', writableRoot: join(view, 'main') }, agents: [{ agentId: 'map', writableRoot: join(view, 'map') },
        { agentId: 'characters', writableRoot: join(view, 'characters') }] }, base })
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
    const absent = { ...target, path: 'main/absent.md' }
    const binding = { worlds, worldId: world.worldId, initialization: opened.workflow, deliveryId: done.value.id, targets: [target, absent] }
    const storyWorld = await bindStoryWorld(binding)
    const snapshot = await storyWorld.readDelivery([target])
    assert.equal(snapshot.artifacts[0]?.content, '城门夜间关闭')
    assert.equal(snapshot.artifacts[0]?.version, done.value.review.artifacts[0]?.version)
    assert.deepEqual(snapshot.uncovered, done.value.review.uncovered)
    const map = await MapStore.open({ fs: contexts.fs, root: join(world.readRoot, 'map'), worldId: world.worldId, access: 'read-write', singleWriterProcess: true })
    t.after(() => map.close())
    await map.createOverview({ name: '曲水城地图', description: '', orientation: '北向上', scale: { width: 10, height: 10, unit: 'km' }, layers: [{ id: 'admin', name: '行政' }], reserved: [] })
    const city = await map.createPlace({ name: '曲水城', aliases: [], description: '城外有高地概况。', detailLevel: 'overview', reserved: [],
      parents: [{ layerId: 'admin', parent: { kind: 'world' }, localBoxes: [[0, 0, 80, 80]], frameBox: null, coverage: 'complete' }] })
    await initializeCatalog(world.catalogRoot, world.worldId)
    const catalog = await CatalogService.open(world, { singleWriterProcess: true })
    const owner = catalog.bind('map')
    const registered = await owner.register(`map/${city.path}`, '曲水城空间概况')
    await catalog.close()
    const catalogEntry = { path: registered.record.path, revision: registered.record.revision, category: 'setting' as const }
    const selection = { task: '处理入城请求', delivery: [{ target, category: 'setting' as const }],
      catalog: { agentId: 'main', entries: [catalogEntry] },
      fixed: [{ id: 'merchant-arrived', version: 'fixture-1', category: 'event' as const, content: '商队已抵达城外' },
        { id: 'trade-pressure', version: 'fixture-1', category: 'direction' as const, content: '城防与商贸可能趋紧' }] }
    await assert.rejects(prepareStoryWorldInput(storyWorld, { ...selection, catalog: { ...selection.catalog, entries: [{ ...catalogEntry, revision: randomUUID() }] } }), /版本已变化/)
    const input = await prepareStoryWorldInput(storyWorld, selection)
    const planRoot = join(base, 'plans'); await mkdir(planRoot)
    const director = new DirectorAdapter(['{"kind":"planned","events":["处理入城请求","天亮后再议"]}'])
    const planOptions = { root: planRoot, protectedRoots: [world.readRoot, roots.delivery], provider: 'test', model: 'test', adapter: director }
    const plan = await createStoryPlan(planOptions, input)
    assert.equal(plan.formatVersion, 2)
    assert.deepEqual(await readStoryPlan(planOptions, plan.id), plan)
    assert.match(JSON.stringify(director.requests), /商队已抵达城外/)
    const collaborationRoot = join(base, 'collaborations'); await mkdir(collaborationRoot)
    const sceneRoots = { planRoot, collaborationRoot, protectedRoots: planOptions.protectedRoots }
    const mapNeed = { cityId: city.id, layerId: 'admin', purpose: '寻找可停放货车的城门外等候点' }
    const scope = { binding: storyWorld, store: map, ownerAgentId: 'map', cityId: city.id, layerId: 'admin' }
    let savedScene: { storyId: string; sceneId: string } | undefined
    const worldBefore = await map.snapshot()
    const characters = await CharacterStore.open(join(world.readRoot, 'characters'), true)
    t.after(() => characters.close())
    const guard = await characters.create({ name: '守卫', summary: '值守城门', categories: {}, body: '守卫私料：交班安排' })
    const leader = await characters.create({ name: '领队', summary: '带队抵达', categories: {}, body: '领队私料：货物容易变质' })
    const candidates = await Promise.all([guard, leader].map(async ({ id }) => ({ characterId: id, version: (await characters.readVersioned(id)).version, presence: '在场' })))
    const round = await runStoryTree({ ...sceneRoots, provider: 'test', model: 'test', limit: 1,
      adapter: new DirectorAdapter([advance, task, JSON.stringify({ kind: 'direct', preparation: '城门交涉', mapNeed }), directorReport, '已接收']),
      async simulate({ runId, storyId, mapNeed: requested, recordSceneResult }, signal) {
        assert.deepEqual(requested, mapNeed)
        const denied = await inspectStoryMapScene(sceneRoots, runId, storyId, { ...scope, cityId: randomUUID() }, mapNeed)
        assert.equal(denied.result.status, 'forbidden')
        const checked = await inspectStoryMapScene(sceneRoots, runId, storyId, scope, mapNeed)
        assert.equal(checked.result.status, 'missing')
        assert.deepEqual(await readStoryMapCheck(sceneRoots, runId, storyId, checked.id), checked)
        const mapDirector = new DirectorAdapter([JSON.stringify({ status: 'proposed', cityId: city.id, layerId: 'admin',
          gate: { kind: 'proposed', description: '拟将城门置于北侧' }, waiting: { name: '北门外高地', description: '临时停放车队', relativeToGate: '城门以北' } })])
        const proposalModel = { provider: 'test', model: 'test', adapter: mapDirector, timeoutMs: 5000 }
        const proposal = await requestStoryMapProposal(sceneRoots, runId, storyId, checked.id, scope, proposalModel, signal)
        assert.equal(proposal.result.status, 'proposed')
        assert.deepEqual(await readStoryMapProposal(sceneRoots, runId, storyId, checked.id), proposal)
        assert.equal(mapDirector.requests[0]?.tools?.length ?? 0, 0)
        assert.doesNotMatch(JSON.stringify(mapDirector.requests), /城门夜间关闭|商队已抵达城外/)
        await assert.rejects(requestStoryMapProposal(sceneRoots, runId, storyId, checked.id, scope, proposalModel, signal), { code: 'EEXIST' })
        assert.equal(mapDirector.requests.length, 1)
        const setup = { order: 1, situation: '商队夜间抵达城门', preparation: '在北门外高地等候并处理入城请求' }
        const badCheck = await inspectStoryMapScene(sceneRoots, runId, storyId, scope, mapNeed)
        const badAdapter = new DirectorAdapter([JSON.stringify({ status: 'proposed', cityId: randomUUID(), layerId: 'admin',
          gate: { kind: 'proposed', description: '其他地区城门' }, waiting: { name: '其他地点', description: '供车队等候', relativeToGate: '城门以北' } })])
        const invalid = await requestStoryMapProposal(sceneRoots, runId, storyId, badCheck.id, scope, { ...proposalModel, adapter: badAdapter }, signal)
        assert.equal(invalid.result.status, 'invalid')
        await assert.rejects(createStorySceneWithMap(sceneRoots, runId, storyId, badCheck.id, scope, setup, async () => {
          throw new Error('无效提案不得提交审阅')
        }), /未形成可用提案/)
        await assert.rejects(createStoryScene(sceneRoots, runId, storyId, setup), /缺少已核对的地图资料/)
        await assert.rejects(createStorySceneWithMap(sceneRoots, runId, storyId, checked.id, scope, setup), /尚未取得可信审阅/)
        await assert.rejects(createStorySceneWithMap(sceneRoots, runId, storyId, checked.id, scope, setup,
          async () => ({ status: 'rejected', reason: '等候点适用条件未核实' })), /未采纳/)
        const scene = await createStorySceneWithMap(sceneRoots, runId, storyId, checked.id, scope, setup, async ({ proposal: candidate, materials }) => {
          assert.equal(candidate.waiting.name, '北门外高地')
          assert.ok(materials.some(item => item.category === 'setting' && item.content.includes('城门夜间关闭')))
          return { status: 'accepted', actor: '固定验收审阅者', reason: '城外临时等候，保持夜间闭门' }
        }, signal)
        assert.equal(scene.formatVersion, 2)
        assert.deepEqual(await readStoryScene(sceneRoots, runId, storyId, scene.sceneId), scene)
        const participants = bindStoryCharacters(sceneRoots, { runId, storyId }, { binding: storyWorld, ownerAgentId: 'characters', store: characters, candidates })
        const choice = new DirectorAdapter([JSON.stringify({ participants: [{ characterId: guard.id, invitation: '回应城外车队' }] })])
        const selectOptions = { provider: 'test', model: 'test', adapter: choice }
        const requests = await selectStoryCharacters(participants, scene.sceneId, [guard.id, leader.id], selectOptions, signal)
        assert.equal(requests[0]?.characterId, guard.id)
        assert.equal(requests[0]?.profileVersion, candidates[0]?.version)
        assert.doesNotMatch(JSON.stringify(choice.requests), /守卫私料|领队私料/)
        const guardRequest = requests[0]!
        const guardGrants: CharacterKnowledgeGrant[] = [
          { characterId: guard.id, sceneId: scene.sceneId, category: 'profile', content: '守卫私料：交班安排', basis: '本人档案', source: { kind: 'profile' } },
          { characterId: guard.id, sceneId: scene.sceneId, category: 'observation', content: '商队夜间抵达城门', basis: '在城门内值守', source: { kind: 'scene', field: 'situation' } },
          { characterId: guard.id, sceneId: scene.sceneId, category: 'known', content: '城门夜间关闭', basis: '值守人员已知', source: { kind: 'world', index: 0, version: snapshot.artifacts[0]!.version } },
        ]
        const guardKnowledge = await participants.prepare(guardRequest, guardGrants)
        assert.deepEqual(guardKnowledge.entries.map(item => item.category), ['profile', 'observation', 'known'])
        assert.doesNotMatch(JSON.stringify(guardKnowledge), /领队私料|北门外高地|商贸可能趋紧/)
        await assert.rejects(participants.prepare(guardRequest, [{ ...guardGrants[0]!, characterId: leader.id }]), /授权角色/)
        await assert.rejects(participants.prepare({ ...guardRequest }, guardGrants), /未由当前子故事签发/)
        await assert.rejects(participants.prepare(guardRequest, [...guardGrants, { ...guardGrants[2]!, source: { kind: 'world', index: 3, version: 'fixture-1' } }]), /无权读取/)
        await assert.rejects(participants.prepare(guardRequest, [...guardGrants, { ...guardGrants[2]!, source: { kind: 'world', index: 0, version: 'old' } }]), /版本已变化/)
        await assert.rejects(selectStoryCharacters(participants, scene.sceneId, [randomUUID()], selectOptions), /授权候选/)
        const duplicate = new DirectorAdapter([JSON.stringify({ participants: [{ characterId: guard.id, invitation: '一' }, { characterId: guard.id, invitation: '二' }] })])
        await assert.rejects(selectStoryCharacters(participants, scene.sceneId, [guard.id], { ...selectOptions, adapter: duplicate }), /重复邀请/)
        savedScene = { storyId, sceneId: scene.sceneId }
        await recordSceneResult(scene.sceneId, { status: 'completed', simulation })
        return simulation
      },
    }, plan.id)
    if (round.kind !== 'paused') throw new Error('预期入城故事完成后暂停')
    assert.equal((await inspectStoryProgress(sceneRoots, plan.id)).status, 'paused')
    assert.ok(savedScene)
    const completedStoryId = savedScene.storyId
    assert.deepEqual(await map.snapshot(), worldBefore)
    assert.deepEqual(await storyWorld.readDelivery([target]), snapshot)
    await assert.rejects(storyWorld.readDelivery([absent]), /未覆盖/)
    await assert.rejects(storyWorld.readDelivery([{ ...target, path: 'main/forbidden.md' }]), /无权/)
    await assert.rejects(bindStoryWorld({ ...binding, worldId: names.find(name => name !== world.worldId)! }), /世界绑定不匹配/)
    const unknownDelivery = await bindStoryWorld({ ...binding, deliveryId: randomUUID() })
    await assert.rejects(unknownDelivery.readDelivery([target]), /不存在/)
    const malformedId = randomUUID()
    const malformedPath = join(roots.delivery, 'deliveries', `${malformedId}.json`)
    const malformed = await bindStoryWorld({ ...binding, deliveryId: malformedId })
    await writeFile(malformedPath, JSON.stringify({ ...done.value, id: malformedId, formatVersion: 999 }))
    await assert.rejects(malformed.readDelivery([target]))
    await writeFile(malformedPath, JSON.stringify({ ...done.value, id: malformedId, review: { ...done.value.review,
      artifacts: done.value.review.artifacts.map(item => ({ ...item, content: '内容已经损坏' })) } }))
    await assert.rejects(malformed.readDelivery([target]), /摘要不匹配/)
    await opened.close()
    await assert.rejects(storyWorld.readDelivery([target]), /已关闭/)
    const evidence = await readStorySceneWorldEvidence(sceneRoots, plan.id, savedScene.storyId, savedScene.sceneId)
    assert.equal(evidence.world.deliveryVersion, snapshot.version)
    assert.equal(evidence.world.materials.find(item => item.source.kind === 'catalog')?.digest, registered.record.contentSha256)
    assert.equal(evidence.world.materials.find(item => item.category === 'direction')?.content, '城防与商贸可能趋紧')
    assert.equal(evidence.check.result.status, 'missing')
    assert.equal(evidence.proposal?.result.status, 'proposed')
    if (evidence.scene.formatVersion !== 2) throw new Error('预期地图场景设置')
    assert.equal(evidence.scene.mapEvidence.adoption?.actor, '固定验收审阅者')
    const proofPath = join(collaborationRoot, `${plan.id}.${savedScene.storyId}.${evidence.check.id}.map-check.json`)
    const originalProof = await readFile(proofPath, 'utf8')
    await writeFile(proofPath, JSON.stringify({ ...evidence.check, result: { ...evidence.check.result, snapshotVersion: 'changed' } }))
    await assert.rejects(readStorySceneWorldEvidence(sceneRoots, plan.id, savedScene.storyId, savedScene.sceneId), /地图核查证据不匹配/)
    assert.equal((await inspectStoryProgress(sceneRoots, plan.id)).status, 'needs-review')
    await writeFile(proofPath, originalProof)
    const continuation = new DirectorAdapter([...leaf('天亮后再议'), achieved])
    const ended = await continueStoryTree({ ...sceneRoots, provider: 'test', model: 'test', adapter: continuation,
      async simulate({ storyId, mapNeed: requested }) {
        assert.notEqual(storyId, completedStoryId)
        assert.equal(requested, undefined)
        return simulation
      },
    }, plan.id, round.batch)
    assert.equal(ended.kind, 'result')
    assert.match(JSON.stringify(continuation.requests), /城防与商贸可能趋紧/)
    assert.equal((await readStoryRoundResult(sceneRoots, plan.id)).assessment.status, 'achieved')
  }
  assert.equal(await readFile(join(configs[0]!.world.readRoot, 'main', 'city.md'), 'utf8'), '城门夜间关闭')
  assert.equal(await readFile(join(configs[1]!.world.readRoot, 'main', 'city.md'), 'utf8'), '城门夜间关闭')
})
