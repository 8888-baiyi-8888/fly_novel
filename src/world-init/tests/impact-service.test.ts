import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@fly-novel/fs-local'
import { MapStore, formatMapDocument } from '@fly-novel/map'
import { CharacterStore, formatCharacterDocument } from '@fly-novel/character'
import { HistoryQueries, HistoryStore } from '@fly-novel/history'
import { OrganizationStore } from '@fly-novel/organization'
import { DiscussionService } from '../discussion/service.js'
import { createInitialDiscussionAdapter } from '../discussion/initial-adapters.js'
import { ImpactService } from '../impact/service.js'
import { ReviewService } from '../impact/review.js'
import { readWorldReview } from '../../app/world-review.js'

test('影响检查记录真实正文与范围，新增关联使原报告过期', async t => {
  const temp = join(process.cwd(), 'tmp'); await mkdir(temp, { recursive: true })
  const root = await realpath(await mkdtemp(join(temp, 'impact-test-'))); t.after(() => rm(root, { recursive: true, force: true }))
  const view = join(root, 'world'); const pending = join(root, 'pending'); const reports = join(root, 'reports')
  for (const dir of ['main', 'confirmed', 'catalog', 'map/places', 'map/connections', 'characters', 'history/events', 'history/candidates',
    'organization/organizations', 'organization/relations', 'organization/memberships']) await mkdir(join(view, dir), { recursive: true })
  const reviews = join(root, 'reviews')
  for (const dir of [join(pending, 'discussions'), join(pending, 'candidates'), reports, join(reviews, 'reviews'), join(reviews, 'confirmations')]) await mkdir(dir, { recursive: true })
  const world = { worldId: 'impact-world', readRoot: view, confirmedRoot: join(view, 'confirmed'), catalogRoot: join(view, 'catalog'),
    mainAgent: { agentId: 'main', writableRoot: join(view, 'main') }, agents: [
      { agentId: 'map', writableRoot: join(view, 'map') }, { agentId: 'character', writableRoot: join(view, 'characters') },
      { agentId: 'history', writableRoot: join(view, 'history') }, { agentId: 'organization', writableRoot: join(view, 'organization') }] }
  const context = new Context(); const backend = context.plugin(LocalFileSystem, { cwd: root }); await backend; t.after(() => backend.dispose())
  const map = await MapStore.open({ fs: context.fs, root: join(view, 'map'), worldId: world.worldId, access: 'read-write', singleWriterProcess: true }); t.after(() => map.close())
  await map.createOverview({ name: '河谷', description: '', scale: { width: 100, height: 100, unit: 'km' }, layers: [{ id: 'area', name: '区域' }], orientation: '北', reserved: [] })
  const city = await map.createPlace({ name: '曲水城', aliases: [], description: '城门开放', detailLevel: 'overview',
    parents: [{ layerId: 'area', parent: { kind: 'world' }, localBoxes: [[0, 0, 100, 100]], frameBox: null, coverage: 'complete' }], reserved: [] })
  const characters = await CharacterStore.open(join(view, 'characters'), true); t.after(() => characters.close())
  const person = await characters.create({ name: '林岚', summary: '', categories: {}, body: '夜间带商队入城' })
  const history = await HistoryStore.open({ fs: context.fs, root: join(view, 'history'), worldId: world.worldId, access: 'read-write', phase: 'initialization', singleWriterProcess: true,
    resolvePlace: async id => id === city.id ? { id, worldId: world.worldId } : null }); t.after(() => history.close())
  const event = (name: string) => ({ name, aliases: [], detailLevel: 'overview' as const, summary: '', body: '经过城门', time: [], parents: [], childrenCoverage: 'unknown' as const,
    relations: [], references: [{ kind: 'linked' as const, type: 'place' as const, id: city.id, description: '' }], publicAccounts: [], hidden: { state: 'unknown' as const, note: '' }, reserved: [] })
  await history.create(event('旧事件'))
  const organization = await OrganizationStore.open({ fs: context.fs, root: join(view, 'organization'), worldId: world.worldId, access: 'read-write', phase: 'initialization', singleWriterProcess: true,
    resolvePerson: async id => id === person.id ? { id, worldId: world.worldId } : null }); t.after(() => organization.close())
  const sect = await organization.createOrganization({ name: '青云宗', aliases: [], organizationType: null, detailLevel: 'overview', minLevel: 0, sections: [], locations: [], reserved: [] })
  const member = { organizationId: sect.id, person: { kind: 'linked' as const, id: person.id }, roles: ['长老'], period: null, description: '', minLevel: 0 as const }
  await organization.createMembership(member)
  const adapter = createInitialDiscussionAdapter(world, { map: { agentId: 'map', store: map }, characters: { agentId: 'character', store: characters },
    history: { agentId: 'history', store: history }, organization: { agentId: 'organization', store: organization } })
  const discussion = await DiscussionService.open({ worldId: world.worldId, root: pending, worldRoots: [view], fs: context.fs, adapter, singleWriterProcess: true }); t.after(() => discussion.close())
  const cityTarget = { kind: 'place' as const, id: city.id }; const d = await discussion.createDiscussion(cityTarget, 'city')
  const cityDoc = (await map.readPlace(city.id)).document
  const candidate = await discussion.createCandidate(d.id, cityTarget, formatMapDocument({ ...cityDoc, description: '夜间关闭' }), '城门')
  await assert.rejects(ImpactService.open({ workspaces: [world], worldId: world.worldId, root: reports, fs: context.fs, discussion, singleWriterProcess: true,
    map: { agentId: 'history', store: map } }), /负责人不匹配/)
  await assert.rejects(ImpactService.open({ workspaces: [world], worldId: 'other', root: reports, fs: context.fs, discussion, singleWriterProcess: true }), /世界绑定不匹配/)
  const impact = await ImpactService.open({ workspaces: [world], worldId: world.worldId, root: reports, fs: context.fs, discussion, singleWriterProcess: true,
    map: { agentId: 'map', store: map }, history: { agentId: 'history', store: history }, organization: { agentId: 'organization', store: organization } }); t.after(() => impact.close())
  const checked = await impact.check(d.id, candidate.value.id)
  assert.equal(checked.report.status, 'completed')
  assert.equal(checked.report.currentContent.includes('城门开放'), true)
  assert.equal(checked.report.candidateContent.includes('夜间关闭'), true)
  assert.equal(checked.report.scopes.find(item => item.name === '历史引用')?.sources.length, 1)
  assert.equal(checked.report.scopes.find(item => item.name === '人物经历')?.status, 'uncovered')
  assert.equal((await impact.verify(d.id, checked.report.id, checked.version)).status, 'current')
  assert.equal((await impact.read(d.id, checked.report.id)).version, checked.version)
  await assert.rejects(impact.read('11111111-1111-4111-8111-111111111111', checked.report.id), /身份不匹配/)
  const review = await ReviewService.open({ workspaces: [world], worldId: world.worldId, root: reviews, fs: context.fs, discussion, impact, singleWriterProcess: true }); t.after(() => review.close())
  const finding = { description: '城门规则与历史需要核对', severity: 'important' as const,
    evidence: [{ reportId: checked.report.id, scope: '历史引用', sourceId: checked.report.scopes.find(item => item.name === '历史引用')!.sources[0]!.id }],
    options: [{ label: '处理', effect: '采用城门候选', candidateIds: [candidate.value.id], resolves: true },
      { label: '保留冲突', effect: '不处理', candidateIds: [], resolves: false }], recommendedIndex: 0 }
  const draft = await review.create(d.id, [checked.report.id], { findings: [finding], dependencies: [] })
  assert.equal((await review.read(d.id, draft.value.id)).version, draft.version)
  const presented = await readWorldReview(review, d.id, draft.value.id)
  assert.ok(presented.changes[0]!.difference.removed.join('\n').includes('城门开放'))
  assert.ok(presented.changes[0]!.difference.added.join('\n').includes('夜间关闭'))
  assert.equal(presented.findings[0]!.recommendedOptionId, presented.findings[0]!.options[0]!.id)
  const uncovered = checked.report.scopes.filter(scope => scope.status === 'uncovered').map(scope => ({ reportId: checked.report.id, scope: scope.name }))
  const input = { reviewVersion: draft.version, confirmContinue: true as const, selectedCandidateIds: [candidate.value.id], selections: [], acknowledgedUncovered: uncovered }
  await assert.rejects(review.confirm(d.id, draft.value.id, { ...input, confirmContinue: false as true }), /明确确认/)
  await assert.rejects(review.confirm(d.id, draft.value.id, { ...input, acknowledgedUncovered: [] }), /未覆盖/)
  await assert.rejects(review.confirm(d.id, draft.value.id, { ...input, selections: [{ findingId: draft.value.findings[0]!.id, optionId: draft.value.findings[0]!.options[1]!.id }] }), /重要冲突/)
  const confirmed = await review.confirm(d.id, draft.value.id, input)
  assert.equal(confirmed.value.choices[0]!.origin, 'recommended')
  assert.equal((await review.readConfirmation(d.id, draft.value.id)).version, confirmed.version)
  await assert.rejects(review.confirm(d.id, draft.value.id, input), /已存在|不确定/)
  const explicitDraft = await review.create(d.id, [checked.report.id], { findings: [finding], dependencies: [] })
  const explicit = await review.confirm(d.id, explicitDraft.value.id, { ...input, reviewVersion: explicitDraft.version,
    selections: [{ findingId: explicitDraft.value.findings[0]!.id, optionId: explicitDraft.value.findings[0]!.options[0]!.id }] })
  assert.equal(explicit.value.choices[0]!.origin, 'explicit')
  const noSuggestion = await review.create(d.id, [checked.report.id], { findings: [{ ...finding, recommendedIndex: null }], dependencies: [] })
  await assert.rejects(review.confirm(d.id, noSuggestion.value.id, { ...input, reviewVersion: noSuggestion.version }), /缺少有效选择/)
  const currentPerson = await characters.read(person.id)
  const other = await discussion.createCandidate(d.id, { kind: 'character', id: person.id }, formatCharacterDocument({ ...currentPerson, metadata: { ...currentPerson.metadata, contentStatus: 'pending' }, body: '白天入城' }), '人物经历')
  const otherReport = await impact.check(d.id, other.value.id)
  const dependent = await review.create(d.id, [checked.report.id, otherReport.report.id], { findings: [], dependencies: [{ candidateIds: [candidate.value.id, other.value.id], reason: '地点和人物需要一致' }] })
  const allUncovered = dependent.value.reports.flatMap(({ report }) => report.scopes.filter(scope => scope.status === 'uncovered').map(scope => ({ reportId: report.id, scope: scope.name })))
  await assert.rejects(review.confirm(d.id, dependent.value.id, { ...input, reviewVersion: dependent.version, acknowledgedUncovered: allUncovered }), /已知不一致/)
  await discussion.abandonCandidate(d.id, other.value.id, other.version)
  const staleDraft = await review.create(d.id, [checked.report.id], { findings: [], dependencies: [] })
  const altered = await review.create(d.id, [checked.report.id], { findings: [], dependencies: [] })
  const alteredPath = join(reviews, 'reviews', `${altered.value.id}.json`)
  const alteredText = await readFile(alteredPath, 'utf8')
  await writeFile(alteredPath, alteredText.replace('城门开放', '虚构正文'))
  const alteredRead = await review.read(d.id, altered.value.id)
  await assert.rejects(review.confirm(d.id, altered.value.id, { ...input, reviewVersion: alteredRead.version }), /不一致/)
  await history.create(event('新增事件'))
  assert.equal((await impact.verify(d.id, checked.report.id, checked.version)).status, 'changed')
  await assert.rejects(review.confirm(d.id, staleDraft.value.id, { ...input, reviewVersion: staleDraft.version }), /重新检查/)
  assert.equal((await map.readPlace(city.id)).document.description, '城门开放')
  const search = HistoryQueries.prototype.search; let pages = 0
  const mocked = t.mock.method(HistoryQueries.prototype, 'search', async function (this: HistoryQueries, ...args: Parameters<HistoryQueries['search']>) {
    if (++pages === 2) throw new Error('模拟后续页读取失败')
    return { ...await search.call(this, ...args), nextOffset: 1 }
  })
  const partial = await impact.check(d.id, candidate.value.id)
  mocked.mock.restore()
  const partialHistory = partial.report.scopes.find(item => item.name === '历史引用')!
  assert.equal(partial.report.status, 'failed'); assert.equal(partialHistory.status, 'failed')
  assert.ok(partialHistory.sources.length > 0); assert.match(partialHistory.reason, /后续页/)
  const failedReview = await review.create(d.id, [partial.report.id], { findings: [], dependencies: [] })
  const failedUncovered = partial.report.scopes.filter(scope => scope.status === 'uncovered').map(scope => ({ reportId: partial.report.id, scope: scope.name }))
  await assert.rejects(review.confirm(d.id, failedReview.value.id, { ...input, reviewVersion: failedReview.version, acknowledgedUncovered: failedUncovered }), /检查未完成/)
  let enter!: () => void; let release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve }); const wait = new Promise<void>(resolve => { release = resolve })
  const originalSnapshot = map.snapshot.bind(map)
  const snapshotMock = t.mock.method(map, 'snapshot', async (...args: Parameters<typeof map.snapshot>) => {
    const result = await originalSnapshot(...args); enter(); await wait; return result
  })
  const checking = impact.check(d.id, candidate.value.id)
  await entered
  await discussion.updateCandidate(d.id, candidate.value.id, candidate.version, formatMapDocument({ ...cityDoc, description: '夜间关闭，商队例外' }), '补充')
  release(); const concurrent = await checking; snapshotMock.mock.restore()
  assert.equal(concurrent.report.status, 'changed')
  const originalWrite = context.fs.writeText.bind(context.fs)
  const publishMock = t.mock.method(context.fs, 'writeText', async (...args: Parameters<typeof context.fs.writeText>) => {
    await originalWrite(...args); throw new Error('模拟报告发布后响应丢失')
  })
  let unknownId = ''
  try { await impact.check(d.id, candidate.value.id); assert.fail('应报告发布结果不确定') }
  catch (error) { assert.ok(error instanceof Error); unknownId = error.message.match(/[0-9a-f-]{36}/)?.[0] ?? ''; assert.ok(unknownId) }
  finally { publishMock.mock.restore() }
  assert.equal((await impact.read(d.id, unknownId)).report.discussionId, d.id)

  const personTarget = { kind: 'character' as const, id: person.id }; const p = await discussion.createDiscussion(personTarget, 'person')
  const personDoc = await characters.read(person.id)
  const personCandidate = await discussion.createCandidate(p.id, personTarget, formatCharacterDocument({ ...personDoc, metadata: { ...personDoc.metadata, contentStatus: 'pending' }, body: '新职务' }), '人物')
  const personReport = await impact.check(p.id, personCandidate.value.id)
  assert.equal(personReport.report.scopes.find(item => item.name === '组织成员')?.sources.length, 1)
  await organization.createMembership({ ...member, roles: ['外务'] })
  assert.equal((await impact.verify(p.id, personReport.report.id, personReport.version)).status, 'changed')
  const aborted = new AbortController(); aborted.abort()
  assert.equal((await impact.check(p.id, personCandidate.value.id, aborted.signal)).report.status, 'cancelled')
  await history.close()
  const failed = await impact.check(p.id, personCandidate.value.id)
  assert.equal(failed.report.status, 'failed')
  assert.equal(failed.report.scopes.find(item => item.name === '历史引用')?.status, 'failed')
  assert.equal((await impact.verify(p.id, failed.report.id, failed.version)).status, 'changed')
  const reportPath = join(reports, `${checked.report.id}.json`)
  const old = await readFile(reportPath, 'utf8'); await writeFile(reportPath, old.replace('"formatVersion": 1', '"formatVersion": 99'))
  await assert.rejects(impact.read(d.id, checked.report.id))
  assert.match(await readFile(reportPath, 'utf8'), /"formatVersion": 99/)
})
