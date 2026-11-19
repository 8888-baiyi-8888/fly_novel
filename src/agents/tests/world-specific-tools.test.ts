import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test, type TestContext } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@fly-novel/fs-local'
import { ToolsService } from '@fly-novel/tools'
import type { ToolCallId } from '@fly-novel/llm'
import { SpecificStore, SpecificQueries, specificToolsPlugin, type SpecificContent } from '@fly-novel/world-specific'

const id = '00000000-0000-4000-8000-000000000001'
const data = (name: string): SpecificContent => ({ name, aliases: [], detailLevel: 'overview', summary: '', body: '', reserved: [], topicIds: [], links: [], references: [] })
async function setup(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'specific-tools-'))); t.after(() => rm(root, { recursive: true, force: true })); for (const folder of ['topics', 'items', 'candidates']) await mkdir(join(root, folder))
  const context = new Context(); const fs = await context.plugin(LocalFileSystem, { cwd: root }); t.after(() => fs.dispose())
  const store = await SpecificStore.open({ fs: context.fs, root, worldId: 'world', phase: 'initialization', access: 'read-write', singleWriterProcess: true, resolveReference: async (type, value) => { if (type === 'organization') throw new Error('模拟无权'); if (type === 'history') return undefined; return value === id ? { id: value, worldId: 'world', version: 'v2' } : null } }); t.after(() => store.close()); return { root, context, store }
}
test('主题搜索含同名候选，多个主题查询相同正文及全部归属', async t => {
  const { store } = await setup(t); const query = new SpecificQueries(store)
  const a = await store.create('topic', data('修炼')); const b = await store.create('topic', data('交易')); await store.create('topic', data('修炼'))
  assert.equal((await query.search({ kind: 'topic', keyword: '修炼' })).total, 2)
  const item = await store.create('item', { ...data('灵石'), topicIds: [a.id, b.id], references: [{ kind: 'unresolved', type: 'place', description: '矿脉待定位' }] })
  for (const topicId of [a.id, b.id]) { const page = await query.search({ kind: 'item', topicId }); assert.equal(page.total, 1); assert.equal(page.items[0]?.id, item.id); assert.deepEqual(page.items[0]?.topicIds, [a.id, b.id]); assert.equal(page.coverage, 'unknown') }
  const related = await query.related('topic', a.id); assert.deepEqual(related.memberships[0]?.topicIds, [a.id, b.id])
  const unresolved = await query.search({ kind: 'item', reference: { type: 'place', id } }); assert.equal(unresolved.total, 0); assert.equal(unresolved.referenceUncertain, true)
  const page = await query.search({ kind: 'topic', limit: 1 }); await store.create('topic', data('航行'))
  await assert.rejects(query.search({ kind: 'topic', offset: 1, limit: 1, version: page.version }), { code: 'SPECIFIC_CONFLICT' })
})
test('外部引用版本、缺失、未配置和权限失败分开报告', async t => {
  const { store } = await setup(t); const topic = await store.create('topic', data('修炼'))
  assert.equal((await store.checkReference('place', id, 'v1')).status, 'changed'); assert.equal((await store.checkReference('place', id, null)).status, 'version_unknown')
  assert.equal((await store.checkReference('history', id, null)).status, 'unconfigured'); assert.equal((await store.checkReference('place', '00000000-0000-4000-8000-000000000002', null)).status, 'not_found')
  await assert.rejects(store.checkReference('organization', id, null), /无权/)
  await assert.rejects(store.create('item', { ...data('关联无权'), topicIds: [topic.id], references: [{ kind: 'linked', type: 'organization', id, description: '', observedVersion: null }] }), /无权/)
})
test('插件按身份注册和释放工具，只读不暴露写操作', async t => {
  const { store, context, root } = await setup(t); const service = new ToolsService({ id: 'planner', name: '专有内容', role: 'general' }); t.after(() => service.dispose()); context.provide('tools', service)
  const read = await context.plugin(specificToolsPlugin, { store, access: 'read-only' }); assert.equal(service.get('world_specific_topic_create'), undefined); await read.dispose()
  const scope = await context.plugin(specificToolsPlugin, { store, access: 'read-write' }); assert.ok(service.get('world_specific_topic_create'))
  const response = await service.execute({ calls: [{ type: 'tool-call', id: 'create' as ToolCallId, name: 'world_specific_topic_create', arguments: JSON.stringify({ content: data('航行') }) }], workingDirectory: root, signal: new AbortController().signal })
  assert.equal(response.results[0]?.result.isError, false); await scope.dispose(); assert.equal(service.get('world_specific_topic_create'), undefined)
})
