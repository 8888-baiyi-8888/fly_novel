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

test('影响检查记录真实正文与范围，新增关联使原报告过期', async t => {
  const temp = join(process.cwd(), 'tmp'); await mkdir(temp, { recursive: true })
  const root = await realpath(await mkdtemp(join(temp, 'impact-test-'))); t.after(() => rm(root, { recursive: true, force: true }))
  const view = join(root, 'world'); const pending = join(root, 'pending'); const reports = join(root, 'reports')
  for (const dir of ['main', 'confirmed', 'catalog', 'map/places', 'map/connections', 'characters', 'history/events', 'history/candidates',
    'organization/organizations', 'organization/relations', 'organization/memberships']) await mkdir(join(view, dir), { recursive: true })
  for (const dir of [join(pending, 'discussions'), join(pending, 'candidates'), reports]) await mkdir(dir, { recursive: true })
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
  await history.create(event('新增事件'))
  assert.equal((await impact.verify(d.id, checked.report.id, checked.version)).status, 'changed')
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
