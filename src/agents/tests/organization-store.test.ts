import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@fly-novel/fs-local'
import { OrganizationStore, OrganizationStoreError, parseOrganization, parseOrganizationMembership, parseOrganizationRelation,
  type Organization, type OrganizationMembership, type OrganizationRelation } from '@fly-novel/organization'

const personId = '11111111-1111-4111-8111-111111111111'
const placeId = '22222222-2222-4222-8222-222222222222'
const missingId = '33333333-3333-4333-8333-333333333333'
const input = (name: string): Omit<Organization, 'formatVersion' | 'worldId' | 'id' | 'reviewStatus'> => ({
  name, aliases: [], organizationType: null, detailLevel: 'overview', minLevel: 0, sections: [{ title: '概况', content: '资料', minLevel: 0 }], locations: [], reserved: [],
})
const relation = (fromId: string, toId: string): Omit<OrganizationRelation, 'formatVersion' | 'worldId' | 'id'> => ({
  fromId, toId, kind: 'subordination', label: '隶属', direction: 'one-way', fromMinLevel: 0, toMinLevel: 0, description: '',
})
const membership = (organizationId: string): Omit<OrganizationMembership, 'formatVersion' | 'worldId' | 'id'> => ({
  organizationId, person: { kind: 'unresolved', description: '尚未建档的长老' }, roles: ['长老'], period: null, description: '', minLevel: 3,
})

async function setup(t: TestContext) {
  const temp = join(process.cwd(), 'tmp'); await mkdir(temp, { recursive: true })
  const root = await realpath(await mkdtemp(join(temp, 'organization-store-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const dir of ['organizations', 'relations', 'memberships']) await mkdir(join(root, dir))
  const ctx = new Context(); const scope = await ctx.plugin(LocalFileSystem, { cwd: root }); t.after(() => scope.dispose())
  const fs = ctx.fs as LocalFileSystem
  const config = { fs, root, worldId: 'org-world', phase: 'initialization' as const, access: 'read-write' as const, singleWriterProcess: true as const,
    resolvePerson: async (id: string) => id === personId ? { id, worldId: 'org-world' } : null,
    resolvePlace: async (id: string) => id === placeId ? { id, worldId: 'org-world' } : null }
  const store = await OrganizationStore.open(config); t.after(() => store.close())
  return { root, fs, config, store }
}

test('组织 JSON 拒绝重复键、未知版本、无效权限与错误结构', () => {
  const org = { ...input('青云宗'), id: personId, worldId: 'org-world', formatVersion: 1, reviewStatus: 'suggested' }
  const json = JSON.stringify(org)
  assert.equal(parseOrganization(json).name, '青云宗')
  assert.throws(() => parseOrganization(json.replace('"name":"青云宗"', '"name":"青云宗","name":"别名"')))
  assert.throws(() => parseOrganization(json.replace('"name":"青云宗"', '"name":"青云宗","\\u006eame":"别名"')))
  assert.throws(() => parseOrganization(json.replace('"formatVersion":1', '"formatVersion":2')))
  assert.throws(() => parseOrganization(JSON.stringify({ ...org, minLevel: 3, sections: [{ title: '秘密', content: '', minLevel: 1 }] })))
  assert.throws(() => parseOrganization(JSON.stringify({ ...org, extra: true })))
  assert.throws(() => parseOrganization(JSON.stringify({ ...org, locations: [{ place: { kind: 'linked', id: 'city.qushui' }, purpose: '驻地', minLevel: 0 }] })))
  assert.throws(() => parseOrganizationRelation(JSON.stringify({ ...relation(personId, placeId), id: missingId, worldId: 'org-world', formatVersion: 1, direction: 'two-way' })))
  assert.throws(() => parseOrganizationMembership(JSON.stringify({ ...membership(personId), id: missingId, worldId: 'org-world', formatVersion: 1, minLevel: 5 })))
})

test('同名组织、多父级统属及未关联成员分别建档并按版本更新', async t => {
  const { root, store } = await setup(t)
  const a = await store.createOrganization(input('青云宗')); const b = await store.createOrganization(input('青云宗'))
  const c = await store.createOrganization(input('传功堂'))
  assert.notEqual(a.id, b.id)
  const ca = await store.createRelation(relation(c.id, a.id)); await store.createRelation(relation(c.id, b.id))
  await assert.rejects(store.createRelation(relation(a.id, c.id)), { code: 'ORG_INVALID_DOCUMENT' })
  const general = { ...relation(a.id, c.id), kind: 'general' as const, label: '合作', direction: 'two-way' as const }
  const collaboration = await store.createRelation(general)
  const current = await store.readRelation(collaboration.id)
  await assert.rejects(store.updateRelation(collaboration.id, current.version, relation(a.id, c.id)), { code: 'ORG_INVALID_DOCUMENT' })
  assert.equal((await store.readRelation(collaboration.id)).document.label, '合作')
  const changed = await store.updateRelation(collaboration.id, current.version, { ...general, label: '竞争' })
  await assert.rejects(store.updateRelation(collaboration.id, current.version, general), { code: 'ORG_CONFLICT' })
  assert.equal((await store.readRelation(collaboration.id)).document.label, '竞争')
  assert.equal((await store.readRelation(ca.id)).document.toId, a.id)
  const org = await store.readOrganization(a.id)
  const updated = await store.updateOrganization(a.id, org.version, { ...input('新青云宗'), detailLevel: 'detailed' })
  await assert.rejects(store.updateOrganization(a.id, org.version, input('过期')), { code: 'ORG_CONFLICT' })
  assert.equal((await store.readOrganization(a.id)).version, updated.version)
  const member = await store.createMembership(membership(a.id)); const memberRead = await store.readMembership(member.id)
  assert.equal(memberRead.document.person.kind, 'unresolved')
  const linked = await store.updateMembership(member.id, memberRead.version, { ...membership(a.id), person: { kind: 'linked', id: personId } })
  await assert.rejects(store.updateMembership(member.id, memberRead.version, membership(a.id)), { code: 'ORG_CONFLICT' })
  const now = await store.readMembership(member.id)
  assert.deepEqual(now.document.person, { kind: 'linked', id: personId }); assert.equal(now.version, linked.version)
  assert.equal((await store.readRelation(collaboration.id)).version, changed.version)
  assert.equal((await readdir(join(root, 'organizations'))).length, 3)
})

test('跨模块引用必须由可信解析器核验，允许未关联线索', async t => {
  const { store, config } = await setup(t)
  const withPlace = { ...input('宗门'), locations: [{ place: { kind: 'linked' as const, id: placeId }, purpose: '总部', minLevel: 0 }] }
  const a = await store.createOrganization(withPlace)
  await store.createMembership({ ...membership(a.id), person: { kind: 'linked', id: personId } })
  await assert.rejects(store.createOrganization({ ...withPlace, locations: [{ ...withPlace.locations[0], place: { kind: 'linked', id: missingId } }] }), { code: 'ORG_INVALID_DOCUMENT' })
  await assert.rejects(store.createMembership({ ...membership(a.id), person: { kind: 'linked', id: missingId } }), { code: 'ORG_INVALID_DOCUMENT' })
  await assert.rejects(store.createMembership(membership(missingId)), { code: 'ORG_NOT_FOUND' })
  await store.close()
  const without = await OrganizationStore.open({ ...config, resolvePerson: undefined, resolvePlace: async id => ({ id, worldId: 'other-world' }) })
  try {
    await assert.rejects(without.createOrganization(withPlace), { code: 'ORG_INVALID_DOCUMENT' })
    await assert.rejects(without.createMembership({ ...membership(a.id), person: { kind: 'linked', id: personId } }), { code: 'ORG_REFERENCE_UNAVAILABLE' })
    await without.createMembership(membership(a.id))
  } finally { await without.close() }
})

test('损坏、重复身份、其他世界或未知版本拒绝并保留原文', async t => {
  const { root, store } = await setup(t)
  const a = await store.createOrganization(input('原文')); const path = join(root, a.path); const before = await readFile(path, 'utf8')
  const badPath = join(root, 'organizations', `${missingId}.json`)
  for (const bad of [before, before.replace('"worldId": "org-world"', '"worldId": "other-world"').replace(a.id, missingId), '{"formatVersion":1,"formatVersion":1}', before.replace('"formatVersion": 1', '"formatVersion": 2').replace(a.id, missingId)]) {
    await writeFile(badPath, bad)
    await assert.rejects(store.createOrganization(input('不应创建')), { code: 'ORG_INVALID_DOCUMENT' })
    assert.equal(await readFile(badPath, 'utf8'), bad)
    assert.equal(await readFile(path, 'utf8'), before)
  }
})

test('只读、占用、大小上限与文件链接都受控', async t => {
  const { root, store, config } = await setup(t)
  const a = await store.createOrganization(input('保留'))
  await assert.rejects(OrganizationStore.open(config), { code: 'ORG_BUSY' })
  await store.close()
  const reader = await OrganizationStore.open({ ...config, access: 'read-only' })
  await assert.rejects(reader.createOrganization(input('禁止写入')), { code: 'ORG_FORBIDDEN' })
  await reader.close()
  const limited = await OrganizationStore.open({ ...config, access: 'read-only', maxDocumentBytes: 16 })
  await assert.rejects(limited.readOrganization(a.id), { code: 'FS_TOO_LARGE' }); await limited.close()
  const external = join(root, a.path); const original = await readFile(external, 'utf8')
  const link = join(root, 'organizations', `${missingId}.json`)
  try { await symlink(external, link, 'file') } catch (error) {
    if (!(error instanceof Error && 'code' in error && ['EPERM', 'EACCES', 'ENOTSUP'].includes(String(error.code)))) throw error
    const target = join(root, 'external-directory'); await mkdir(target)
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  }
  const reopened = await OrganizationStore.open(config)
  try { await assert.rejects(reopened.readOrganization(missingId), { code: 'ORG_FORBIDDEN' }); assert.equal(await readFile(external, 'utf8'), original) }
  finally { await reopened.close() }
})

test('取消未发布的写入并在关闭时等待已受理操作', async t => {
  const { root, fs, store } = await setup(t)
  const controller = new AbortController(); fs.internals.inspectTemp = () => controller.abort()
  await assert.rejects(store.createOrganization(input('取消'), controller.signal), { code: 'FS_ABORTED' })
  delete fs.internals.inspectTemp; assert.deepEqual(await readdir(join(root, 'organizations')), [])
  let entered!: () => void; let release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve }); const proceed = new Promise<void>(resolve => { release = resolve })
  fs.internals.inspectTemp = async () => { entered(); await proceed }
  const pending = store.createOrganization(input('已受理')); await started
  let closed = false; const closing = store.close().then(() => { closed = true })
  await assert.rejects(store.createOrganization(input('关闭后')), { code: 'ORG_CLOSED' }); assert.equal(closed, false)
  release(); const saved = await pending; await closing
  assert.match(await readFile(join(root, saved.path), 'utf8'), /已受理/)
  delete fs.internals.inspectTemp
})

test('提交结果不确定时提供核查路径并保留实际成果', async t => {
  const { root, fs, store } = await setup(t)
  const write = fs.writeText.bind(fs)
  t.mock.method(fs, 'writeText', async (...args: Parameters<typeof write>) => { await write(...args); throw new Error('模拟发布后失败') })
  let caught: unknown
  try { await store.createOrganization(input('待核查')) } catch (error) { caught = error }
  assert.ok(caught instanceof OrganizationStoreError && caught.code === 'ORG_COMMIT_UNKNOWN' && caught.path)
  assert.match(await readFile(join(root, caught.path), 'utf8'), /待核查/)
})
