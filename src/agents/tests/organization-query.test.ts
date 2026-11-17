import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@fly-novel/fs-local'
import { ToolsService } from '@fly-novel/tools'
import type { ToolCallId } from '@fly-novel/llm'
import { createOrganizationTools, organizationToolsPlugin, OrganizationQueries, OrganizationStore, type Organization, type OrganizationQueryBinding } from '@fly-novel/organization'

const characterId = '11111111-1111-4111-8111-111111111111'
const otherCharacterId = '22222222-2222-4222-8222-222222222222'
const missingId = '33333333-3333-4333-8333-333333333333'
const org = (name: string, minLevel = 0): Omit<Organization, 'formatVersion' | 'worldId' | 'id' | 'reviewStatus'> => ({
  name, aliases: [], organizationType: '宗门', detailLevel: 'overview', minLevel,
  sections: [{ title: '公开', content: '公开内容', minLevel }, { title: '秘密', content: '隐秘计划', minLevel: 3 }],
  locations: [], reserved: [],
})
async function setup(t: TestContext) {
  const temp = join(process.cwd(), 'tmp'); await mkdir(temp, { recursive: true })
  const root = await realpath(await mkdtemp(join(temp, 'organization-query-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const dir of ['organizations', 'relations', 'memberships']) await mkdir(join(root, dir))
  const ctx = new Context(); const scope = await ctx.plugin(LocalFileSystem, { cwd: root }); t.after(() => scope.dispose())
  const store = await OrganizationStore.open({ fs: ctx.fs, root, worldId: 'org-world', phase: 'initialization', access: 'read-write', singleWriterProcess: true,
    resolvePerson: async id => [characterId, otherCharacterId].includes(id) ? { id, worldId: 'org-world' } : null })
  t.after(() => store.close())
  const a = await store.createOrganization(org('青云宗')); const b = await store.createOrganization(org('青云宗')); const secret = await store.createOrganization(org('秘密组织', 3))
  const branch = await store.createOrganization(org('传功堂'))
  const edge = (toId: string) => ({ fromId: branch.id, toId, kind: 'subordination' as const, label: '隶属', direction: 'one-way' as const, fromMinLevel: 0, toMinLevel: 0, description: '' })
  await store.createRelation(edge(a.id)); await store.createRelation(edge(b.id))
  const hiddenRelation = await store.createRelation({ fromId: a.id, toId: secret.id, kind: 'general', label: '秘密合作', direction: 'one-way', fromMinLevel: 3, toMinLevel: 3, description: '秘密关系' })
  const hiddenMember = await store.createMembership({ organizationId: a.id, person: { kind: 'linked', id: characterId }, roles: ['暗线'], period: null, description: '秘密成员', minLevel: 3 })
  const publicMember = await store.createMembership({ organizationId: a.id, person: { kind: 'unresolved', description: '未建档弟子' }, roles: ['弟子'], period: null, description: '', minLevel: 1 })
  return { root, fs: ctx.fs as LocalFileSystem, store, a, b, secret, branch, hiddenMember, publicMember, hiddenRelation }
}
function binding(grants: { organizationId: string; level: number }[], getRevision: () => string = () => 'r1'): OrganizationQueryBinding {
  return { kind: 'character', worldId: 'org-world', characterId, readGrants: async () => ({ worldId: 'org-world', characterId, revision: getRevision(), grants }) }
}

test('角色分级过滤组织正文、秘密成员及双端关系', async t => {
  const { store, a, b, secret, hiddenMember, publicMember, hiddenRelation } = await setup(t)
  for (const level of [0, 1, 2, 3, 4]) {
    const query = new OrganizationQueries(store, binding([{ organizationId: a.id, level }, { organizationId: secret.id, level }]))
    const visible = await query.readOrganization(a.id)
    assert.equal(visible.path, undefined)
    assert.equal(visible.document.sections.some(section => section.content === '隐秘计划'), level >= 3)
    const members = await query.memberships({ organizationId: a.id })
    assert.equal(members.items.some(item => item.document.id === hiddenMember.id), level >= 3)
    assert.equal(members.items.some(item => item.document.id === publicMember.id), level >= 1)
    const relations = await query.relations({ organizationId: a.id })
    assert.equal(relations.items.some(item => item.document.id === hiddenRelation.id), level >= 3)
    const found = await query.search({ keyword: '秘密组织' }); assert.equal(found.items.length, level >= 3 ? 1 : 0)
    if (level < 3) {
      const hiddenError = await query.readMembership(hiddenMember.id).catch(error => ({ code: error.code, message: error.message }))
      const missingError = await query.readMembership(missingId).catch(error => ({ code: error.code, message: error.message }))
      assert.deepEqual(hiddenError, missingError)
    }
  }
  const different = new OrganizationQueries(store, binding([{ organizationId: a.id, level: 4 }, { organizationId: b.id, level: 1 }]))
  assert.equal((await different.search({ keyword: '秘密组织' })).items.length, 0)
  assert.equal((await different.relations({ organizationId: a.id })).items.some(item => item.document.id === hiddenRelation.id), false)
})

test('同名、成员双向查询、多上级及可见路径', async t => {
  const { store, a, b, branch, hiddenMember } = await setup(t)
  const planner = new OrganizationQueries(store, { kind: 'planner', worldId: 'org-world' })
  assert.equal((await planner.search({ keyword: '青云宗' })).items.length, 2)
  assert.equal((await planner.memberships({ organizationId: a.id })).items.some(item => item.document.id === hiddenMember.id), true)
  assert.equal((await planner.memberships({ personId: characterId })).items.some(item => item.document.id === hiddenMember.id), true)
  assert.equal((await planner.memberships({ personId: otherCharacterId })).items.length, 0)
  const children = await planner.tree('children', { id: a.id })
  assert.deepEqual(children.items.find(item => item.organization.document.id === branch.id)?.visibleParents.sort(), [a.id, b.id].sort())
  const ancestors = await planner.tree('ancestors', { id: branch.id })
  assert.equal(ancestors.items.length, 2)
})

test('未授权秘密内容变化不改变分页版本，授权或可见数据变化会使旧页失效', async t => {
  const { store, a, secret } = await setup(t)
  const grants = [{ organizationId: a.id, level: 0 }]; let revision = 'r1'
  const query = new OrganizationQueries(store, binding(grants, () => revision))
  const first = await query.search({ limit: 1 })
  const secretBefore = await store.readOrganization(secret.id)
  await store.updateOrganization(secret.id, secretBefore.version, org('秘密组织改名', 3))
  const aBefore = await store.readOrganization(a.id)
  await store.updateOrganization(a.id, aBefore.version, { ...org('青云宗'), sections: [{ title: '公开', content: '公开内容', minLevel: 0 }, { title: '秘密', content: '新的秘密', minLevel: 3 }] })
  const next = await query.search({ offset: 1, limit: 1, version: first.version })
  assert.equal(next.version, first.version)
  grants[0].level = 1; revision = 'r2'
  await assert.rejects(query.search({ offset: 1, limit: 1, version: first.version }), { code: 'ORG_CONFLICT' })
  const nextFirst = await query.search({ limit: 1 })
  const current = await store.readOrganization(a.id)
  await store.updateOrganization(a.id, current.version, { ...org('更名'), sections: [{ title: '公开', content: '公开内容', minLevel: 0 }] })
  await assert.rejects(query.search({ offset: 1, limit: 1, version: nextFirst.version }), { code: 'ORG_CONFLICT' })
})

test('授权身份、世界及查询期间授权变化均被拒绝', async t => {
  const { store } = await setup(t)
  assert.throws(() => new OrganizationQueries(store, { kind: 'planner', worldId: 'other' }), { code: 'ORG_INVALID_CONFIG' })
  const wrong = new OrganizationQueries(store, { kind: 'character', worldId: 'org-world', characterId, readGrants: async () => ({ worldId: 'other', characterId, revision: '1', grants: [] }) })
  await assert.rejects(wrong.search({}), { code: 'ORG_FORBIDDEN' })
  let count = 0
  const changing = new OrganizationQueries(store, { kind: 'character', worldId: 'org-world', characterId, readGrants: async () => ({ worldId: 'org-world', characterId, revision: String(count++), grants: [] }) })
  await assert.rejects(changing.search({}), { code: 'ORG_CONFLICT' })
  const controller = new AbortController(); controller.abort()
  await assert.rejects(changing.search({}, controller.signal))
})

test('插件注册和注销组织工具，角色无法写入或通过参数冒用身份', async t => {
  const { store, root, a } = await setup(t)
  const role = new ToolsService({ id: 'role-agent', name: '角色', role: 'character' }); t.after(() => role.dispose())
  assert.ok(role.agent)
  assert.throws(() => createOrganizationTools(store, role.agent!, binding([]), 'read-write'), { code: 'ORG_FORBIDDEN' })
  const context = new Context(); context.provide('tools', role)
  const scope = await context.plugin(organizationToolsPlugin, { store, binding: binding([]), access: 'read-only' })
  assert.ok(role.get('organization_search')); assert.equal(role.get('organization_create'), undefined); assert.equal(role.get('organization_reference_check'), undefined)
  const call = async (name: string, args: object) => (await role.execute({ calls: [{ type: 'tool-call', id: 'id' as ToolCallId, name, arguments: JSON.stringify(args) }], workingDirectory: root, signal: new AbortController().signal })).results[0].result
  assert.equal((await call('organization_read', { id: a.id })).isError, false)
  assert.equal((await call('organization_search', { characterId: otherCharacterId, level: 4 })).isError, true)
  assert.equal((await call('organization_read', { id: a.id, worldId: 'other' })).isError, true)
  await scope.dispose(); assert.equal(role.get('organization_search'), undefined)
})

test('规划者写工具报告未确定提交的实际路径', async t => {
  const { store, root, fs } = await setup(t)
  const write = fs.writeText.bind(fs)
  t.mock.method(fs, 'writeText', async (...args: Parameters<typeof write>) => { await write(...args); throw new Error('模拟发布后失败') })
  const service = new ToolsService({ id: 'planner', name: '组织', role: 'general' }); t.after(() => service.dispose()); assert.ok(service.agent)
  for (const tool of createOrganizationTools(store, service.agent, { kind: 'planner', worldId: 'org-world' }, 'read-write')) service.register(tool)
  const result = (await service.execute({ calls: [{ type: 'tool-call', id: 'create' as ToolCallId, name: 'organization_create', arguments: JSON.stringify({ content: org('新组织') }) }], workingDirectory: root, signal: new AbortController().signal })).results[0].result
  assert.equal(result.isError, false)
  if (result.isError || !result.value || typeof result.value !== 'object' || Array.isArray(result.value)) throw new Error('结果无效')
  assert.equal(result.value.status, 'unknown')
  assert.equal(typeof result.value.path, 'string')
  assert.match(await readFile(join(root, String(result.value.path)), 'utf8'), /新组织/)
})
