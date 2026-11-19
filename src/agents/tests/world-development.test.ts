import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test, type TestContext } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@fly-novel/fs-local'
import { ToolsService } from '@fly-novel/tools'
import type { ToolCallId } from '@fly-novel/llm'
import { DevelopmentStore, DevelopmentQueries, developmentToolsPlugin, type DevelopmentContent } from '@fly-novel/world-development'

const a = '00000000-0000-4000-8000-000000000001'; const b = '00000000-0000-4000-8000-000000000002'; const person = '00000000-0000-4000-8000-000000000003'; const point = '00000000-0000-4000-8000-000000000004'
const data = (name: string): DevelopmentContent => ({ name, summary: '', body: '', reserved: [], applicability: { kind: 'unknown' }, references: [], links: [], person: null })
async function setup(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'development-'))); t.after(() => rm(root, { recursive: true, force: true }))
  for (const folder of ['macro-development/blueprints', 'macro-development/directions', 'macro-development/proposals', 'storylines/stories', 'storylines/growth-lines', 'character-growth/blueprints', 'character-growth/items', 'candidates']) await mkdir(join(root, folder), { recursive: true })
  const context = new Context(); const scope = await context.plugin(LocalFileSystem, { cwd: root }); t.after(() => scope.dispose())
  const store = await DevelopmentStore.open({ fs: context.fs, root, worldId: 'world', access: 'read-write', phase: 'initialization', singleWriterProcess: true,
    resolveReference: async (_type, id) => [person, point].includes(id) ? { id, worldId: 'world', version: 'v2' } : null,
    resolveSituation: async (overviewId, situationId) => [a, b].includes(overviewId) && (!situationId || (overviewId === a && situationId === point)) ? { worldId: 'world', overviewId, situationId, version: 'v1' } : null })
  t.after(() => store.close()); return { root, context, store }
}
test('候选局势条件互不串用，未知与通用分开，条目错配拒绝', async t => {
  const { store } = await setup(t); const query = new DevelopmentQueries(store)
  await store.create('direction', { ...data('封渠'), applicability: { kind: 'scoped', scopes: [{ overviewId: a, description: '封渠持续', situationIds: [point], observedVersion: 'old' }] } })
  await store.create('direction', { ...data('通水'), applicability: { kind: 'scoped', scopes: [{ overviewId: b, description: '协议失效', situationIds: [] }] } })
  await store.create('direction', { ...data('共同背景'), applicability: { kind: 'general', description: '不依赖方案' } })
  await store.create('direction', data('尚未判断'))
  await assert.rejects(store.create('direction', { ...data('错配'), applicability: { kind: 'scoped', scopes: [{ overviewId: b, description: '错配', situationIds: [point] }] } }), { code: 'DEVELOPMENT_INVALID_DOCUMENT' })
  const result = await query.search({ overviewId: a }); assert.deepEqual(result.items.map(item => item.name).sort(), ['共同背景', '封渠'].sort()); assert.equal(result.unknown[0]?.name, '尚未判断'); assert.equal(result.items.find(item => item.name === '封渠')?.sourceVersionStatus, 'changed')
  const page = await query.search({ overviewId: a, limit: 1 }); await store.create('direction', data('变更'))
  await assert.rejects(query.search({ overviewId: a, offset: 1, limit: 1, version: page.version }), { code: 'DEVELOPMENT_CONFLICT' })
})
test('同人物只有一条成长线，线索绑定冲突不破坏原文', async t => {
  const { store } = await setup(t)
  const linked = { ...data('林岚'), person: { kind: 'linked' as const, id: person } }; const first = await store.create('growth-line', linked)
  await store.create('growth-item', { ...data('人物呼应'), links: [{ targetKind: 'growth-line', targetId: first.id, relation: '规划', description: '' }] })
  assert.ok((await new DevelopmentQueries(store).search({ personId: person })).items.some(item => item.name === '人物呼应'))
  await assert.rejects(store.create('growth-line', { ...linked, name: '另一条' }), { code: 'DEVELOPMENT_CONFLICT' })
  const clue = { ...data('未知人物'), person: { kind: 'unresolved' as const, description: '河谷代表' } }; const candidate = await store.create('growth-line', clue)
  await assert.rejects(store.update('growth-line', candidate.id, candidate.version, linked), { code: 'DEVELOPMENT_CONFLICT' })
  assert.deepEqual((await store.readDocument('growth-line', candidate.id)).document.person, clue.person)
  await store.update('growth-line', candidate.id, candidate.version, { ...clue, person: { kind: 'linked', id: point } })
  assert.deepEqual((await store.readDocument('growth-line', candidate.id)).document.person, { kind: 'linked', id: point, originalClue: '河谷代表' })
  const updated = await store.update('growth-line', first.id, first.version, { ...linked, body: '合作或坚持本城利益，视不同局势而定。' }); assert.ok(updated.version)
})
test('多故事线引用同一事件，反向查询保留原始方向', async t => {
  const { store } = await setup(t); const query = new DevelopmentQueries(store); const event = await store.create('proposal', data('谈判'))
  const link = { targetKind: 'proposal' as const, targetId: event.id, relation: '关联', description: '可能参与' }
  const story = await store.create('storyline', { ...data('水源'), links: [link] }); await store.create('storyline', { ...data('边境'), links: [link] })
  const related = await query.related('proposal', event.id); assert.equal(related.items.length, 2); assert.ok(related.items.every(item => item.targetId === event.id && item.fromKind === 'storyline'))
  await assert.rejects(store.create('growth-item', { ...data('错误'), links: [{ ...link, targetId: story.id }] }), { code: 'DEVELOPMENT_INVALID_DOCUMENT' })
})
test('已确认候选、损坏、跨世界及旧版本均保留原数据', async t => {
  const { store, root } = await setup(t); const item = await store.create('direction', data('旧方向')); const path = join(root, item.path); const raw = await readFile(path, 'utf8')
  await assert.rejects(store.update('direction', item.id, 'old', data('新方向')), { code: 'DEVELOPMENT_CONFLICT' })
  await writeFile(path, raw.replace('suggested', 'confirmed')); const old = await store.readDocument('direction', item.id)
  await assert.rejects(store.update('direction', item.id, old.version, data('覆盖')), { code: 'DEVELOPMENT_FORBIDDEN' }); await store.prepare('direction', item.id, old.version, data('候选'))
  assert.equal((await store.readCandidate('direction', item.id)).stale, false); await writeFile(path, raw.replace('suggested', 'confirmed').replace('旧方向', '改名'))
  assert.equal((await store.readCandidate('direction', item.id)).stale, true)
  for (const invalid of ['{"formatVersion":2}', raw.replace('world', 'other'), '{broken', '{"formatVersion":1,"formatVersion":1}']) { await writeFile(path, invalid); await assert.rejects(store.readDocument('direction', item.id), { code: 'DEVELOPMENT_INVALID_DOCUMENT' }); assert.equal(await readFile(path, 'utf8'), invalid) }
})
test('取消及结果不确定保留可核查的实际成果', async t => {
  const { store, root, context } = await setup(t); const cancel = new AbortController(); cancel.abort(); await assert.rejects(store.create('direction', data('取消'), cancel.signal))
  const write = context.fs.writeText.bind(context.fs); const mock = t.mock.method(context.fs, 'writeText', async (...args: Parameters<typeof write>) => { await write(...args); throw new Error('发布后失败') })
  let path = ''; await assert.rejects(store.create('direction', data('已写入')), error => { assert.ok(error instanceof Error && 'code' in error && error.code === 'DEVELOPMENT_COMMIT_UNKNOWN' && 'path' in error && typeof error.path === 'string'); path = error.path; return true }); mock.mock.restore()
  assert.match(await readFile(join(root, path), 'utf8'), /已写入/); assert.equal((await store.snapshot()).items.length, 1)
})
test('插件按可信身份注册读写工具并释放', async t => {
  const { store, context, root } = await setup(t); const service = new ToolsService({ id: 'planner', name: '规划', role: 'general' }); t.after(() => service.dispose()); context.provide('tools', service)
  const read = await context.plugin(developmentToolsPlugin, { store, access: 'read-only' }); assert.equal(service.get('world_development_create'), undefined); await read.dispose()
  const scope = await context.plugin(developmentToolsPlugin, { store, access: 'read-write' }); assert.ok(service.get('world_development_create'))
  const result = await service.execute({ calls: [{ type: 'tool-call', id: 'create' as ToolCallId, name: 'world_development_create', arguments: JSON.stringify({ kind: 'storyline', content: data('河谷') }) }], workingDirectory: root, signal: new AbortController().signal })
  assert.equal(result.results[0]?.result.isError, false); await scope.dispose(); assert.equal(service.get('world_development_create'), undefined)
})
test('外部引用可比较版本并拒绝缺失人物', async t => {
  const { store } = await setup(t)
  assert.equal((await store.checkReference('person', person, 'v1')).status, 'changed')
  assert.equal((await store.checkReference('person', a, 'v1')).status, 'not_found')
  await assert.rejects(store.create('direction', { ...data('无效人物'), references: [{ kind: 'linked', type: 'person', id: a, description: '', observedVersion: null }] }), { code: 'DEVELOPMENT_INVALID_DOCUMENT' })
})
