import assert from 'node:assert/strict'
import fsPromises = require('node:fs/promises')
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@fly-novel/fs-local'
import { MapStore, formatMapDocument } from '@fly-novel/map'
import { CharacterStore, formatCharacterDocument } from '@fly-novel/character'
import { WorldAccess } from '@fly-novel/util'
import { DiscussionService } from '../discussion/service.js'
import { createInitialDiscussionAdapter } from '../discussion/initial-adapters.js'
import { ImpactService } from '../impact/service.js'
import { ReviewService } from '../impact/review.js'
import { WorldCommitService } from '../impact/commit.js'

test('可信确认只发布一次地点候选并保留可核查记录', async t => {
  const parent = join(process.cwd(), 'tmp'); await mkdir(parent, { recursive: true })
  const root = await realpath(await mkdtemp(join(parent, 'world-commit-'))); t.after(() => rm(root, { recursive: true, force: true }))
  const view = join(root, 'world'); const pending = join(root, 'pending'); const reports = join(root, 'reports'); const reviews = join(root, 'reviews'); const operations = join(root, 'operations')
  for (const path of ['main', 'confirmed', 'catalog', 'map/places', 'map/connections', 'characters']) await mkdir(join(view, path), { recursive: true })
  for (const path of [join(pending, 'discussions'), join(pending, 'candidates'), reports, join(reviews, 'reviews'), join(reviews, 'confirmations'), operations]) await mkdir(path, { recursive: true })
  const world = { worldId: 'commit-world', readRoot: view, confirmedRoot: join(view, 'confirmed'), catalogRoot: join(view, 'catalog'),
    mainAgent: { agentId: 'main', writableRoot: join(view, 'main') }, agents: [{ agentId: 'map', writableRoot: join(view, 'map') }, { agentId: 'character', writableRoot: join(view, 'characters') }] }
  const context = new Context(); const backend = await context.plugin(LocalFileSystem, { cwd: root }); t.after(() => backend.dispose())
  const map = await MapStore.open({ fs: context.fs, root: join(view, 'map'), worldId: world.worldId, access: 'read-write', singleWriterProcess: true }); t.after(() => map.close())
  const characters = await CharacterStore.open(join(view, 'characters'), true); t.after(() => characters.close())
  const person = await characters.create({ name: '林岚', summary: '', categories: {}, body: '旧经历' })
  await map.createOverview({ name: '河谷', description: '', scale: { width: 100, height: 100, unit: 'km' }, layers: [{ id: 'area', name: '区域' }], orientation: '北', reserved: [] })
  const city = await map.createPlace({ name: '曲水城', aliases: [], description: '昼夜开放', detailLevel: 'overview',
    parents: [{ layerId: 'area', parent: { kind: 'world' }, localBoxes: [[0, 0, 100, 100]], frameBox: null, coverage: 'complete' }], reserved: [] })
  const adapter = createInitialDiscussionAdapter(world, { map: { agentId: 'map', store: map }, characters: { agentId: 'character', store: characters } })
  const discussion = await DiscussionService.open({ worldId: world.worldId, root: pending, worldRoots: [view], fs: context.fs, adapter, singleWriterProcess: true }); t.after(() => discussion.close())
  const impact = await ImpactService.open({ workspaces: [world], worldId: world.worldId, root: reports, fs: context.fs, discussion, map: { agentId: 'map', store: map }, singleWriterProcess: true }); t.after(() => impact.close())
  const review = await ReviewService.open({ workspaces: [world], worldId: world.worldId, root: reviews, fs: context.fs, discussion, impact, singleWriterProcess: true }); t.after(() => review.close())
  const gate = WorldAccess.register([view, pending, reports, reviews, operations])
  await assert.rejects(WorldCommitService.open({ workspaces: [world], worldId: world.worldId, root: operations, fs: context.fs, gate, discussion, impact, review, sessionRoots: [reviews], map, characters, singleWriterProcess: true }), /Session 根重叠/)
  const service = await WorldCommitService.open({ workspaces: [world], worldId: world.worldId, root: operations, fs: context.fs, gate, discussion, impact, review, sessionRoots: [], map, characters, singleWriterProcess: true }); t.after(async () => { await service.close(); await gate.close() })
  const target = { kind: 'place' as const, id: city.id }; const thread = await discussion.createDiscussion(target, 'session')
  const before = await map.readPlace(city.id)
  const candidate = await discussion.createCandidate(thread.id, target, formatMapDocument({ ...before.document, description: '夜间关闭' }), '城门')
  const report = await impact.check(thread.id, candidate.value.id)
  const draft = await review.create(thread.id, [report.report.id], { findings: [], dependencies: [] })
  const confirmation = await review.confirm(thread.id, draft.value.id, { reviewVersion: draft.version, confirmContinue: true,
    selectedCandidateIds: [candidate.value.id], selections: [], acknowledgedUncovered: report.report.scopes.filter(scope => scope.status === 'uncovered').map(scope => ({ reportId: report.report.id, scope: scope.name })) })
  assert.equal((await map.readPlace(city.id)).document.description, '昼夜开放')
  await assert.rejects(service.submit(thread.id, draft.value.id, 'invalid'), /确认版本/)
  const abort = new AbortController(); abort.abort()
  await assert.rejects(service.submit(thread.id, draft.value.id, confirmation.version, abort.signal))
  await assert.rejects(service.inspect(draft.value.id), /不存在/)
  const result = await service.submit(thread.id, draft.value.id, confirmation.version)
  assert.equal(result.phase, 'committed')
  assert.equal((await map.readPlace(city.id)).document.description, '夜间关闭')
  assert.equal((await discussion.readCandidate(candidate.value.id)).value.status, 'committed')
  assert.equal((await service.inspect(draft.value.id)).value.phase, 'committed')
  await assert.rejects(service.submit(thread.id, draft.value.id, confirmation.version))

  const prepare = async (description: string, session: string) => {
    const nextThread = await discussion.createDiscussion(target, session)
    const current = await map.readPlace(city.id)
    const nextCandidate = await discussion.createCandidate(nextThread.id, target, formatMapDocument({ ...current.document, description }), description)
    const nextReport = await impact.check(nextThread.id, nextCandidate.value.id)
    const nextReview = await review.create(nextThread.id, [nextReport.report.id], { findings: [], dependencies: [] })
    const nextConfirmation = await review.confirm(nextThread.id, nextReview.value.id, { reviewVersion: nextReview.version, confirmContinue: true,
      selectedCandidateIds: [nextCandidate.value.id], selections: [], acknowledgedUncovered: nextReport.report.scopes.filter(scope => scope.status === 'uncovered').map(scope => ({ reportId: nextReport.report.id, scope: scope.name })) })
    return { nextThread, nextCandidate, nextReview, nextConfirmation }
  }
  const uncertain = await prepare('黎明开放', 'second')
  const publish = map.publishPlaceCandidate.bind(map)
  const afterWrite = t.mock.method(map, 'publishPlaceCandidate', async (...args: Parameters<typeof map.publishPlaceCandidate>) => {
    await publish(...args); throw new Error('模拟写入后响应丢失')
  })
  await assert.rejects(service.submit(uncertain.nextThread.id, uncertain.nextReview.value.id, uncertain.nextConfirmation.version), /需要核查/)
  afterWrite.mock.restore()
  assert.equal((await service.inspect(uncertain.nextReview.value.id)).value.phase, 'publishing')
  await assert.rejects(service.reconcile(uncertain.nextReview.value.id), /需用户核查/)
  await assert.rejects(discussion.abandonCandidate(uncertain.nextThread.id, uncertain.nextCandidate.value.id, uncertain.nextCandidate.version), /状态或版本/)
  const observed = await map.readPlace(city.id)
  assert.equal((await service.reconcile(uncertain.nextReview.value.id, { kind: 'accept-result', observedVersion: observed.version })).phase, 'committed')
  assert.equal((await service.inspect(uncertain.nextReview.value.id)).value.recoveryDecision?.observedVersion, observed.version)
  assert.equal((await discussion.readCandidate(uncertain.nextCandidate.value.id)).value.status, 'committed')
  assert.equal((await map.readPlace(city.id)).document.description, '黎明开放')

  const failed = await prepare('日落开放', 'third')
  const beforeWrite = t.mock.method(map, 'publishPlaceCandidate', async () => { throw new Error('模拟发布前失败') })
  await assert.rejects(service.submit(failed.nextThread.id, failed.nextReview.value.id, failed.nextConfirmation.version), /需要核查/)
  beforeWrite.mock.restore()
  await assert.rejects(service.reconcile(failed.nextReview.value.id), /需用户核查/)
  const unchanged = await map.readPlace(city.id)
  assert.equal((await service.reconcile(failed.nextReview.value.id, { kind: 'accept-baseline', observedVersion: unchanged.version })).phase, 'failed')
  assert.equal((await discussion.readCandidate(failed.nextCandidate.value.id)).value.status, 'active')
  assert.equal((await map.readPlace(city.id)).document.description, '黎明开放')
  await discussion.abandonCandidate(failed.nextThread.id, failed.nextCandidate.value.id, (await discussion.readCandidate(failed.nextCandidate.value.id)).version)
  const candidateFailure = await prepare('午后开放', 'candidate-failure')
  const markFailure = t.mock.method(discussion, 'markCommitted', async () => { throw new Error('模拟候选更新失败') })
  await assert.rejects(service.submit(candidateFailure.nextThread.id, candidateFailure.nextReview.value.id, candidateFailure.nextConfirmation.version), /需要核查/)
  markFailure.mock.restore()
  assert.equal((await service.inspect(candidateFailure.nextReview.value.id)).value.phase, 'published')
  assert.equal((await service.reconcile(candidateFailure.nextReview.value.id)).phase, 'committed')
  assert.equal((await discussion.readCandidate(candidateFailure.nextCandidate.value.id)).value.status, 'committed')

  const personTarget = { kind: 'character' as const, id: person.id }; const personThread = await discussion.createDiscussion(personTarget, 'person')
  await characters.prepare(person.id, { name: '林岚', summary: '', categories: {}, body: '旧候选' })
  const currentPerson = await characters.read(person.id)
  const proposed = formatCharacterDocument({ ...currentPerson, metadata: { ...currentPerson.metadata, contentStatus: 'pending' }, body: '新经历' })
  await assert.rejects(discussion.createCandidate(personThread.id, personTarget, proposed, '人物'), /已有候选/)
  await characters.commit(person.id, await characters.readPending(person.id))
  const confirmedPerson = await characters.read(person.id)
  const candidatePerson = await discussion.createCandidate(personThread.id, personTarget, formatCharacterDocument({ ...confirmedPerson,
    metadata: { ...confirmedPerson.metadata, contentStatus: 'pending' }, body: '新经历' }), '人物经历')
  const personReport = await impact.check(personThread.id, candidatePerson.value.id)
  const personReview = await review.create(personThread.id, [personReport.report.id], { findings: [], dependencies: [] })
  const personConfirmation = await review.confirm(personThread.id, personReview.value.id, { reviewVersion: personReview.version, confirmContinue: true,
    selectedCandidateIds: [candidatePerson.value.id], selections: [], acknowledgedUncovered: personReport.report.scopes.filter(scope => scope.status === 'uncovered').map(scope => ({ reportId: personReport.report.id, scope: scope.name })) })
  assert.equal((await service.submit(personThread.id, personReview.value.id, personConfirmation.version)).phase, 'committed')
  const publishedPerson = await characters.read(person.id)
  assert.equal(publishedPerson.body, '新经历\n'); assert.equal(publishedPerson.metadata.contentStatus, 'confirmed')
  const recoverThread = await discussion.createDiscussion(personTarget, 'person-recovery')
  const recoverCandidate = await discussion.createCandidate(recoverThread.id, personTarget, formatCharacterDocument({ ...publishedPerson,
    metadata: { ...publishedPerson.metadata, contentStatus: 'pending' }, body: '索引故障后恢复' }), '恢复人物')
  const recoverReport = await impact.check(recoverThread.id, recoverCandidate.value.id)
  const recoverReview = await review.create(recoverThread.id, [recoverReport.report.id], { findings: [], dependencies: [] })
  const recoverConfirmation = await review.confirm(recoverThread.id, recoverReview.value.id, { reviewVersion: recoverReview.version, confirmContinue: true,
    selectedCandidateIds: [recoverCandidate.value.id], selections: [], acknowledgedUncovered: recoverReport.report.scopes.filter(scope => scope.status === 'uncovered').map(scope => ({ reportId: recoverReport.report.id, scope: scope.name })) })
  const rename = fsPromises.rename
  const indexFailure = t.mock.method(fsPromises, 'rename', async (from: Parameters<typeof rename>[0], to: Parameters<typeof rename>[1]) => {
    if (String(to) === join(view, 'characters', 'index.json')) throw new Error('模拟人物索引失败')
    await rename(from, to)
  })
  await assert.rejects(service.submit(recoverThread.id, recoverReview.value.id, recoverConfirmation.version), /需要核查/)
  indexFailure.mock.restore()
  await assert.rejects(service.reconcile(recoverReview.value.id), /需用户核查/)
  const recoveredVersion = await characters.readVersioned(person.id)
  assert.equal((await service.reconcile(recoverReview.value.id, { kind: 'accept-result', observedVersion: recoveredVersion.version })).phase, 'committed')
  assert.equal((await characters.read(person.id)).body, '索引故障后恢复\n')

  const outdated = await prepare('子夜开放', 'outdated')
  const concurrent = await map.readPlace(city.id)
  await map.publishPlaceCandidate({ ...concurrent.document, description: '另一次修改' }, concurrent.version)
  await assert.rejects(service.submit(outdated.nextThread.id, outdated.nextReview.value.id, outdated.nextConfirmation.version), /重新检查/)
  await assert.rejects(service.inspect(outdated.nextReview.value.id), /不存在/)
  assert.equal((await map.readPlace(city.id)).document.description, '另一次修改')
  await discussion.abandonCandidate(outdated.nextThread.id, outdated.nextCandidate.value.id, outdated.nextCandidate.version)
  const lockFailure = await prepare('尚未写入', 'lock-failure')
  const write = context.fs.writeText.bind(context.fs)
  const recordFailure = t.mock.method(context.fs, 'writeText', async (...args: Parameters<typeof context.fs.writeText>) => {
    if (args[0].displayPath.includes('operations') && args[1].includes('"phase": "publishing"')) throw new Error('模拟发布记录故障')
    return write(...args)
  })
  await assert.rejects(service.submit(lockFailure.nextThread.id, lockFailure.nextReview.value.id, lockFailure.nextConfirmation.version), /发布记录写入失败/)
  recordFailure.mock.restore()
  assert.equal((await discussion.readCandidate(lockFailure.nextCandidate.value.id)).value.status, 'publishing')
  assert.equal((await service.reconcile(lockFailure.nextReview.value.id)).phase, 'failed')
  const restoredCandidate = await discussion.readCandidate(lockFailure.nextCandidate.value.id)
  assert.equal(restoredCandidate.value.status, 'active')
  await discussion.abandonCandidate(lockFailure.nextThread.id, restoredCandidate.value.id, restoredCandidate.version)
  const changedAfterPublish = await prepare('候选发布', 'changed-after-publish')
  const blockCandidate = t.mock.method(discussion, 'markCommitted', async () => { throw new Error('模拟候选更新失败') })
  await assert.rejects(service.submit(changedAfterPublish.nextThread.id, changedAfterPublish.nextReview.value.id, changedAfterPublish.nextConfirmation.version), /需要核查/)
  blockCandidate.mock.restore()
  const later = await map.readPlace(city.id)
  await map.publishPlaceCandidate({ ...later.document, description: '后续资料' }, later.version)
  await assert.rejects(service.reconcile(changedAfterPublish.nextReview.value.id), /正文已变化/)
  assert.equal((await map.readPlace(city.id)).document.description, '后续资料')
  assert.equal((await discussion.readCandidate(changedAfterPublish.nextCandidate.value.id)).value.status, 'publishing')
  const recordPath = join(operations, `${draft.value.id}.json`)
  const unknown = (await readFile(recordPath, 'utf8')).replace('"formatVersion": 1', '"formatVersion": 99')
  await writeFile(recordPath, unknown)
  await assert.rejects(service.inspect(draft.value.id))
  assert.equal(await readFile(recordPath, 'utf8'), unknown)
})
