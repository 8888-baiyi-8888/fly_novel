import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@fly-novel/fs-local'
import { DiscussionService, type DiscussionTargetAdapter } from '../discussion/service.js'
import { createInitialDiscussionAdapter } from '../discussion/initial-adapters.js'
import { MapStore, formatMapDocument } from '@fly-novel/map'
import { CharacterStore, CharacterRelationshipStore, formatCharacterDocument, formatCharacterRelationship } from '@fly-novel/character'
import { OrganizationStore, formatOrganizationDocument } from '@fly-novel/organization'
import { HistoryStore, formatHistoryEvent } from '@fly-novel/history'
import { withFileDiscussionAdapter } from '../discussion/file-adapter.js'

test('讨论候选独占、版本保护、放弃及重启读取', async t => {
  const parent = join(process.cwd(), 'tmp'); await mkdir(parent, { recursive: true })
  const root = await realpath(await mkdtemp(join(parent, 'discussion-store-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const world = join(root, 'world'); const workspace = join(root, 'discussion')
  for (const dir of [world, workspace, join(workspace, 'discussions'), join(workspace, 'candidates')]) await mkdir(dir)
  const context = new Context(); const backend = context.plugin(LocalFileSystem, { cwd: root }); await backend
  t.after(() => backend.dispose())
  let current = { content: '当前正文', version: 'v1' }
  const adapter: DiscussionTargetAdapter = { async read() { return current }, async assertNoLegacyCandidate() {}, async validateStored() {},
    async validate(_target, content) { if (!content) throw new Error('正文为空') } }
  const options = { worldId: 'test-world', root: workspace, worldRoots: [world], fs: context.fs, adapter, singleWriterProcess: true as const }
  const place = { kind: 'place' as const, id: '11111111-1111-4111-8111-111111111111' }
  let service = await DiscussionService.open(options)
  const a = await service.createDiscussion(place, 'session-a'); const b = await service.createDiscussion(place, 'session-b')
  await assert.rejects(service.createDiscussion(place, 'session-a'), /Session 已属于其他讨论/)
  const first = await service.createCandidate(a.id, place, '夜间关闭', '修改城门')
  await assert.rejects(service.createCandidate(b.id, place, '开放', '另一讨论'), /已有有效候选/)
  const changed = await service.updateCandidate(a.id, first.value.id, first.version, '商队例外', '补充例外')
  await assert.rejects(service.updateCandidate(a.id, first.value.id, first.version, '旧版本', '冲突'), /版本不匹配/)
  const concurrent = await Promise.allSettled([
    service.updateCandidate(a.id, first.value.id, changed.version, '甲方案', '并发甲'),
    service.updateCandidate(a.id, first.value.id, changed.version, '乙方案', '并发乙'),
  ])
  assert.equal(concurrent.filter(item => item.status === 'fulfilled').length, 1)
  assert.equal(concurrent.filter(item => item.status === 'rejected').length, 1)
  const latest = await service.readCandidate(first.value.id)
  const observed = await service.readCandidate(first.value.id)
  assert.equal(observed.current.content, '当前正文')
  assert.equal(observed.intent, 'update')
  await service.close(); service = await DiscussionService.open(options)
  assert.equal((await service.readDiscussion(a.id)).sessionId, 'session-a')
  assert.equal((await service.listCandidates(a.id))[0]?.value.content, latest.value.content)
  current = { content: '正文变化', version: 'v2' }
  assert.equal((await service.readCandidate(first.value.id)).stale, true)
  await assert.rejects(service.updateCandidate(a.id, first.value.id, latest.version, '覆盖', '过期'), /基线已过期/)
  await service.abandonCandidate(a.id, first.value.id, latest.version)
  await service.createCandidate(b.id, place, '新候选', '新的讨论')
  assert.equal((await service.readCandidate(first.value.id)).value.status, 'abandoned')
  await service.close()
})

test('未知或损坏候选使创建失败并保留原文件', async t => {
  const parent = join(process.cwd(), 'tmp'); await mkdir(parent, { recursive: true })
  const root = await realpath(await mkdtemp(join(parent, 'discussion-corrupt-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const dir of ['world', 'discussion', 'discussion/discussions', 'discussion/candidates']) await mkdir(join(root, dir))
  const context = new Context(); const backend = context.plugin(LocalFileSystem, { cwd: root }); await backend
  t.after(() => backend.dispose())
  const adapter: DiscussionTargetAdapter = { async read() { return { content: '正文', version: 'v1' } }, async assertNoLegacyCandidate() {}, async validateStored() {}, async validate() {} }
  const service = await DiscussionService.open({ worldId: 'corrupt-world', root: join(root, 'discussion'), worldRoots: [join(root, 'world')], fs: context.fs, adapter, singleWriterProcess: true })
  t.after(() => service.close())
  const target = { kind: 'character' as const, id: '22222222-2222-4222-8222-222222222222' }
  const discussion = await service.createDiscussion(target, 'session')
  const path = join(root, 'discussion', 'candidates', '33333333-3333-4333-8333-333333333333.json')
  await writeFile(path, '{"formatVersion":99}')
  await assert.rejects(service.createCandidate(discussion.id, target, '候选', '说明'))
  assert.equal(await readFile(path, 'utf8'), '{"formatVersion":99}')
})

test('候选发布结果不确定时可按讨论核查实际结果', async t => {
  const parent = join(process.cwd(), 'tmp'); await mkdir(parent, { recursive: true })
  const root = await realpath(await mkdtemp(join(parent, 'discussion-unknown-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const dir of ['world', 'discussion', 'discussion/discussions', 'discussion/candidates']) await mkdir(join(root, dir))
  const context = new Context(); const backend = context.plugin(LocalFileSystem, { cwd: root }); await backend
  t.after(() => backend.dispose())
  const adapter: DiscussionTargetAdapter = { async read() { return { content: '正文', version: 'v1' } }, async assertNoLegacyCandidate() {}, async validateStored() {}, async validate() {} }
  const service = await DiscussionService.open({ worldId: 'unknown-world', root: join(root, 'discussion'), worldRoots: [join(root, 'world')], fs: context.fs, adapter, singleWriterProcess: true })
  t.after(() => service.close())
  const target = { kind: 'place' as const, id: '22222222-2222-4222-8222-222222222222' }
  const discussion = await service.createDiscussion(target, 'session')
  const original = context.fs.writeText.bind(context.fs)
  const mocked = t.mock.method(context.fs, 'writeText', async (...args: Parameters<typeof context.fs.writeText>) => {
    await original(...args); throw new Error('模拟发布后响应丢失')
  })
  await assert.rejects(service.createCandidate(discussion.id, target, '已发布', '说明'), /发布结果不确定/)
  mocked.mock.restore()
  assert.equal((await service.listCandidates(discussion.id))[0]?.value.content, '已发布')
  await assert.rejects(service.createCandidate(discussion.id, target, '重复', '说明'), /已有有效候选/)
})

test('地点和人物使用所属模块校验，已有角色候选不得覆盖', async t => {
  const parent = join(process.cwd(), 'tmp'); await mkdir(parent, { recursive: true })
  const root = await realpath(await mkdtemp(join(parent, 'discussion-real-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const dir of ['world', 'world/main', 'world/confirmed', 'world/catalog', 'world/map', 'world/map/places', 'world/map/connections', 'world/characters', 'world/organization', 'world/organization/organizations', 'world/organization/relations', 'world/organization/memberships', 'world/history', 'world/history/events', 'world/history/candidates', 'discussion', 'discussion/discussions', 'discussion/candidates']) await mkdir(join(root, dir))
  const context = new Context(); const backend = context.plugin(LocalFileSystem, { cwd: root }); await backend
  t.after(() => backend.dispose())
  const map = await MapStore.open({ fs: context.fs, root: join(root, 'world/map'), worldId: 'real-world', access: 'read-write', singleWriterProcess: true })
  t.after(() => map.close())
  const characters = await CharacterStore.open(join(root, 'world/characters'), true); t.after(() => characters.close())
  await map.createOverview({ name: '河谷', description: '', scale: { width: 100, height: 100, unit: 'km' }, layers: [{ id: 'area', name: '地区' }], orientation: '北', reserved: [] })
  const place = await map.createPlace({ name: '曲水城', aliases: [], description: '城门开放', detailLevel: 'overview',
    parents: [{ layerId: 'area', parent: { kind: 'world' }, localBoxes: [[0, 0, 100, 100]], frameBox: null, coverage: 'complete' }], reserved: [] })
  const person = await characters.create({ name: '林岚', summary: '', categories: {}, body: '原文' })
  const other = await characters.create({ name: '阿澜', summary: '', categories: {}, body: '另一个原文' })
  await mkdir(join(root, 'world/characters/relationships'))
  const relationships = await CharacterRelationshipStore.open({ root: join(root, 'world/characters/relationships'), worldId: 'real-world', phase: 'initialization', singleWriterProcess: true,
    resolvePerson: async id => [person.id, other.id].includes(id) ? { id, worldId: 'real-world' } : null })
  t.after(() => relationships.close())
  const relation = await relationships.create({ participants: [{ kind: 'linked', id: person.id }, { kind: 'linked', id: other.id }], relations: [{ name: '伙伴', direction: 'two-way', description: '同行' }] })
  const organization = await OrganizationStore.open({ fs: context.fs, root: join(root, 'world/organization'), worldId: 'real-world',
    access: 'read-write', phase: 'initialization', singleWriterProcess: true, resolvePerson: async id => id === person.id ? { id, worldId: 'real-world' } : null })
  t.after(() => organization.close())
  const sect = await organization.createOrganization({ name: '青云宗', aliases: [], organizationType: null, detailLevel: 'overview', minLevel: 0, sections: [], locations: [], reserved: [] })
  const otherSect = await organization.createOrganization({ name: '白云宗', aliases: [], organizationType: null, detailLevel: 'overview', minLevel: 0, sections: [], locations: [], reserved: [] })
  const orgRelation = await organization.createRelation({ fromId: sect.id, toId: otherSect.id, kind: 'subordination', label: '隶属', direction: 'one-way', fromMinLevel: 0, toMinLevel: 0, description: '' })
  const member = await organization.createMembership({ organizationId: sect.id, person: { kind: 'linked', id: person.id }, roles: ['长老'], period: null, description: '', minLevel: 0 })
  const history = await HistoryStore.open({ fs: context.fs, root: join(root, 'world/history'), worldId: 'real-world', phase: 'initialization', access: 'read-write', singleWriterProcess: true })
  t.after(() => history.close())
  const event = await history.create({ name: '旧事', aliases: [], detailLevel: 'overview', summary: '', body: '原事', time: [], parents: [], childrenCoverage: 'unknown', relations: [], references: [], publicAccounts: [], hidden: { state: 'unknown', note: '' }, reserved: [] })
  const world = { worldId: 'real-world', readRoot: join(root, 'world'), confirmedRoot: join(root, 'world/confirmed'), catalogRoot: join(root, 'world/catalog'),
    mainAgent: { agentId: 'main', writableRoot: join(root, 'world/main') }, agents: [{ agentId: 'map', writableRoot: join(root, 'world/map') }, { agentId: 'person', writableRoot: join(root, 'world/characters') }, { agentId: 'organization', writableRoot: join(root, 'world/organization') }, { agentId: 'history', writableRoot: join(root, 'world/history') }] }
  await writeFile(join(root, 'world/main/world.md'), '第一版总览')
  const modules = createInitialDiscussionAdapter(world, { map: { agentId: 'map', store: map }, characters: { agentId: 'person', store: characters }, organization: { agentId: 'organization', store: organization }, history: { agentId: 'history', store: history }, relationships })
  const service = await DiscussionService.open({ worldId: 'real-world', root: join(root, 'discussion'), worldRoots: [join(root, 'world')], fs: context.fs,
    adapter: withFileDiscussionAdapter(modules, world, context.fs), singleWriterProcess: true })
  t.after(() => service.close())
  const placeTarget = { kind: 'place' as const, id: place.id }; const d = await service.createDiscussion(placeTarget, 'place-session')
  await assert.rejects(service.createDiscussion({ kind: 'place', id: '99999999-9999-4999-8999-999999999999' }, 'missing-session'), /地点不存在/)
  const original = (await map.readPlace(place.id)).document
  const candidate = await service.createCandidate(d.id, placeTarget, formatMapDocument({ ...original, description: '夜间关闭' }), '城门规则')
  assert.equal((await map.readPlace(place.id)).document.description, '城门开放')
  assert.match((await service.readCandidate(candidate.value.id)).value.content, /夜间关闭/)
  await assert.rejects(service.updateCandidate(d.id, candidate.value.id, candidate.version,
    formatMapDocument({ ...original, id: '11111111-1111-4111-8111-111111111111' }), '身份错误'), /身份不匹配/)
  await assert.rejects(service.updateCandidate(d.id, candidate.value.id, candidate.version,
    formatMapDocument({ ...original, parents: [{ ...original.parents[0]!, layerId: 'unknown' }] }), '无效层面'), /未知地图层面/)
  const personTarget = { kind: 'character' as const, id: person.id }; const p = await service.createDiscussion(personTarget, 'person-session')
  const originalPerson = await characters.read(person.id)
  const candidateText = formatCharacterDocument({ ...originalPerson, metadata: { ...originalPerson.metadata, contentStatus: 'pending' }, body: '新职务' })
  await characters.prepare(person.id, { name: '林岚', summary: '', categories: {}, body: '原有候选' })
  await assert.rejects(service.createCandidate(p.id, personTarget, candidateText, '职务'), /已有候选/)
  assert.equal((await characters.readPending(person.id)).document.body, '原有候选\n')
  assert.equal((await characters.read(person.id)).body, '原文\n')
  const otherTarget = { kind: 'character' as const, id: other.id }; const otherDiscussion = await service.createDiscussion(otherTarget, 'other-session')
  const otherCurrent = await characters.read(other.id)
  const otherText = formatCharacterDocument({ ...otherCurrent, metadata: { ...otherCurrent.metadata, contentStatus: 'pending' }, body: '待审职务' })
  const otherCandidate = await service.createCandidate(otherDiscussion.id, otherTarget, otherText, '候选职务')
  assert.match((await service.readCandidate(otherCandidate.value.id)).value.content, /待审职务/)
  assert.equal((await characters.read(other.id)).body, '另一个原文\n')
  const membershipTarget = { kind: 'organization-membership' as const, id: member.id }
  const orgTarget = { kind: 'organization' as const, id: sect.id }; const orgDocument = (await organization.readOrganization(sect.id)).document
  await service.createCandidate(p.id, orgTarget, formatOrganizationDocument({ ...orgDocument, name: '新青云宗' }), '组织修改')
  assert.equal((await organization.readOrganization(sect.id)).document.name, '青云宗')
  const orgRelationTarget = { kind: 'organization-relation' as const, id: orgRelation.id }; const orgRelationDocument = (await organization.readRelation(orgRelation.id)).document
  await service.createCandidate(p.id, orgRelationTarget, formatOrganizationDocument({ ...orgRelationDocument, description: '候选关系' }), '关系修改')
  assert.equal((await organization.readRelation(orgRelation.id)).document.description, '')
  const membership = (await organization.readMembership(member.id)).document
  const membershipCandidate = await service.createCandidate(p.id, membershipTarget, formatOrganizationDocument({ ...membership, roles: ['外务负责人'] }), '成员职务')
  assert.match((await service.readCandidate(membershipCandidate.value.id)).value.content, /外务负责人/)
  assert.deepEqual((await organization.readMembership(member.id)).document.roles, ['长老'])
  await assert.rejects(service.updateCandidate(p.id, membershipCandidate.value.id, membershipCandidate.version,
    formatOrganizationDocument({ ...membership, person: { kind: 'linked', id: other.id } }), '未核验人物'), /引用不存在/)
  const historyTarget = { kind: 'history-event' as const, id: event.id }; const historyDocument = (await history.readEvent(event.id)).document
  const historyCandidate = await service.createCandidate(p.id, historyTarget, formatHistoryEvent({ ...historyDocument, body: '待审旧事' }), '历史修改')
  assert.match((await service.readCandidate(historyCandidate.value.id)).value.content, /待审旧事/)
  assert.equal((await history.readEvent(event.id)).document.body, '原事')
  await writeFile(join(root, 'world/history/candidates', `${event.id}.json`), '旧候选')
  await assert.rejects(service.updateCandidate(p.id, historyCandidate.value.id, historyCandidate.version, historyCandidate.value.content, '再次修改'), /已有候选/)
  const relationTarget = { kind: 'character-relationship' as const, id: relation.document.id }
  const relationCandidate = formatCharacterRelationship({ ...relation.document, relations: relation.document.relations.map(item => ({ ...item, description: '新关系' })) })
  const savedRelation = await service.createCandidate(p.id, relationTarget, relationCandidate, '关系修改')
  const newRelation = { id: '88888888-8888-4888-8888-888888888888', name: '新关系', direction: 'two-way' as const, description: '' }
  await assert.rejects(service.updateCandidate(p.id, savedRelation.value.id, savedRelation.version,
    formatCharacterRelationship({ ...relation.document, relations: [...relation.document.relations, newRelation] }), '新增关系'), /暂不支持新增/)
  assert.equal((await relationships.read(relation.document.id)).document.relations[0]!.description, '同行')
  const fileTarget = { kind: 'file' as const, ownerAgentId: 'main', path: 'main/world.md' }
  const fileDiscussion = await service.createDiscussion(fileTarget, 'file-session')
  await service.createCandidate(fileDiscussion.id, fileTarget, '总览候选', '总览调整')
  assert.equal(await readFile(join(root, 'world/main/world.md'), 'utf8'), '第一版总览')
  await assert.rejects(service.createDiscussion({ kind: 'file', ownerAgentId: 'person', path: 'main/world.md' }, 'denied'), /不属于/)
})
