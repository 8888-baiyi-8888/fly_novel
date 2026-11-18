import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test, type TestContext } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@fly-novel/fs-local'
import { HistoryStore, HistoryQueries, type HistoryEventInput } from '@fly-novel/history'

const id = 'a903f138-ccaf-4ef4-b89f-04d89c3c1ab2'
const data = (name: string): HistoryEventInput => ({ name, aliases: [], detailLevel: 'overview', summary: '', body: '', time: [], parents: [], childrenCoverage: 'unknown',
  relations: [], references: [], publicAccounts: [], hidden: { state: 'unknown', note: '' }, reserved: [] })
async function setup(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'history-store-'))); t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'events')); await mkdir(join(root, 'candidates'))
  const context = new Context(); const scope = await context.plugin(LocalFileSystem, { cwd: root }); t.after(() => scope.dispose())
  const store = await HistoryStore.open({ fs: context.fs, root, worldId: 'world', phase: 'initialization', access: 'read-write', singleWriterProcess: true,
    resolvePerson: async value => value === id ? { id: value, worldId: 'world' } : null })
  t.after(() => store.close()); return { root, store, fs: context.fs }
}

test('历史文件支持多上级、双向关联查询、版本冲突和完整性保护', async t => {
  const { store, root } = await setup(t); const query = new HistoryQueries(store)
  const a = await store.create({ ...data('战争'), childrenCoverage: 'complete' }); const b = await store.create(data('战争'))
  const child = await store.create({ ...data('谈判'), parents: [{ id: a.id, description: '结束' }, { id: b.id, description: '相关谈判' }],
    relations: [{ kind: 'before', targetId: a.id, description: '发生在前' }], references: [{ kind: 'linked', type: 'person', id, description: '' }] })
  const fromA = await query.children({ id: a.id }); assert.equal(fromA.items[0]?.id, child.id); assert.equal(fromA.items[0]?.parents.length, 2)
  assert.equal((await query.ancestors({ id: child.id })).items.length, 2)
  const ancestorPage = await query.ancestors({ id: child.id, limit: 1 })
  await assert.rejects(query.children({ id: child.id, limit: 1, version: ancestorPage.version }), { code: 'HISTORY_CONFLICT' })
  assert.equal((await query.relations({ id: a.id, direction: 'in' })).items[0]?.fromId, child.id)
  assert.equal((await query.relations({ id: a.id, direction: 'out' })).items.length, 0)
  const page = await query.search({ keyword: '战争', limit: 1 }); assert.equal(page.total, 2)
  const current = await store.readEvent(a.id)
  await assert.rejects(store.update(a.id, 'stale', data('错误')), { code: 'HISTORY_CONFLICT' })
  await assert.rejects(store.update(a.id, current.version, { ...data('战争'), parents: [{ id: child.id, description: '循环' }] }), { code: 'HISTORY_INVALID_DOCUMENT' })
  await store.update(a.id, current.version, { ...data('战争'), summary: '更新后' })
  await assert.rejects(query.search({ keyword: '战争', offset: 1, limit: 1, version: page.version }), { code: 'HISTORY_CONFLICT' })
  assert.equal((await store.checkReference('person', id)).status, 'verified')
  await assert.rejects(store.checkReference('place', id), { code: 'HISTORY_REFERENCE_UNAVAILABLE' })
  await store.create({ ...data('未关联'), references: [{ kind: 'unresolved', type: 'person', description: '未知人物' }] })
  const matches = await query.search({ reference: { type: 'person', id } })
  assert.equal(matches.items.length, 1); assert.equal(matches.referenceUncertain, true); assert.equal(matches.complete, false)
  assert.match(await readFile(join(root, child.path), 'utf8'), /谈判/)
})

test('时间线不把约略、未知或多基准排成确定先后，时间搜索保留无法判断项', async t => {
  const { store } = await setup(t); const query = new HistoryQueries(store)
  const exact = (value: number) => [{ kind: 'point' as const, original: `year ${value}`, basis: { kind: 'initialization' as const }, unit: 'year', value, precision: 'exact' as const }]
  await store.create({ ...data('后'), time: exact(-10) }); await store.create({ ...data('前'), time: exact(-20) })
  await store.create({ ...data('约略'), time: [{ ...exact(-15)[0], precision: 'approximate' }] })
  await store.create(data('未知'))
  const timeline = await query.timeline({}); assert.deepEqual(timeline.items.map(value => value.name), ['前', '后'])
  assert.deepEqual(timeline.unknown.map(value => value.name).sort(), ['未知', '约略']); assert.equal(timeline.complete, false)
  const found = await query.search({ timeRange: { basis: { kind: 'initialization' }, unit: 'year', start: -18, end: -5 } })
  assert.deepEqual(found.items.map(value => value.name).sort(), ['后', '未知', '约略'].sort()); assert.equal(found.timeUncertain, true)
})

test('不同纪年即使均为精确时间也不能形成完整排序', async t => {
  const { store } = await setup(t); const query = new HistoryQueries(store)
  await store.create({ ...data('起点参考'), time: [{ kind: 'point', original: '一年前', basis: { kind: 'initialization' }, unit: 'year', value: -1, precision: 'exact' }] })
  await store.create({ ...data('纪年参考'), time: [{ kind: 'point', original: '某纪元一年', basis: { kind: 'era', id: 'era-a' }, unit: 'year', value: 1, precision: 'exact' }] })
  const result = await query.timeline({}); assert.equal(result.items.length, 2); assert.equal(result.unknown.length, 0); assert.equal(result.complete, false)
})

test('已确认事件只能创建候选，候选不覆盖正文并保护基线', async t => {
  const { store, root } = await setup(t); const created = await store.create(data('旧事'))
  const path = join(root, created.path); const raw = await readFile(path, 'utf8'); await writeFile(path, raw.replace('"suggested"', '"confirmed"'))
  const confirmed = await store.readEvent(created.id)
  await assert.rejects(store.update(created.id, confirmed.version, data('修改')), { code: 'HISTORY_FORBIDDEN' })
  await store.prepare(created.id, confirmed.version, data('修改候选'))
  await assert.rejects(store.prepare(created.id, confirmed.version, data('重复候选')), { code: 'HISTORY_CONFLICT' })
  assert.equal((await store.readCandidate(created.id)).stale, false)
  assert.equal(await readFile(path, 'utf8'), raw.replace('"suggested"', '"confirmed"'))
  await writeFile(path, raw.replace('"suggested"', '"confirmed"').replace('旧事', '改名'))
  assert.equal((await store.readCandidate(created.id)).stale, true)
})

test('未确认事件若已有候选则拒绝更新并保留候选原文', async t => {
  const { store, root } = await setup(t); const event = await store.create(data('事件'))
  const candidate = join(root, 'candidates', `${event.id}.json`); await writeFile(candidate, '不可识别的已有候选')
  await assert.rejects(store.update(event.id, event.version, data('新内容')), { code: 'HISTORY_CONFLICT' })
  assert.equal(await readFile(candidate, 'utf8'), '不可识别的已有候选')
  assert.equal((await store.readEvent(event.id)).document.name, '事件')
})

test('取消和发布结果不确定时保留已发布成果并报告核查路径', async t => {
  const { store, fs, root } = await setup(t)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(store.create(data('取消'), controller.signal)); assert.equal((await store.snapshot()).events.length, 0)
  const write = fs.writeText.bind(fs)
  const mock = t.mock.method(fs, 'writeText', async (...args: Parameters<typeof write>) => { await write(...args); throw new Error('模拟发布后失败') })
  let path = ''
  await assert.rejects(store.create(data('已发布')), error => { assert.ok(error instanceof Error && 'code' in error && error.code === 'HISTORY_COMMIT_UNKNOWN' && 'path' in error && typeof error.path === 'string'); path = error.path; return true })
  mock.mock.restore(); assert.match(await readFile(join(root, path), 'utf8'), /已发布/)
  assert.equal((await store.snapshot()).events.length, 1)
})

test('受损、未知版本、跨世界及失效引用均明确拒绝，不修改文件', async t => {
  const { store, root } = await setup(t); const created = await store.create(data('旧事')); const path = join(root, created.path)
  const original = await readFile(path, 'utf8')
  for (const raw of ['{"formatVersion":2}', original.replace('"world"', '"other"'), '{broken']) {
    await writeFile(path, raw); await assert.rejects(store.readEvent(created.id), { code: 'HISTORY_INVALID_DOCUMENT' }); assert.equal(await readFile(path, 'utf8'), raw)
  }
  await writeFile(path, original)
  await assert.rejects(store.create({ ...data('引用缺失'), references: [{ kind: 'linked', type: 'person', id: '00000000-0000-4000-8000-000000000001', description: '' }] }), { code: 'HISTORY_INVALID_DOCUMENT' })
  await assert.rejects(store.create({ ...data('缺少解析器'), references: [{ kind: 'linked', type: 'organization', id, description: '' }] }), { code: 'HISTORY_REFERENCE_UNAVAILABLE' })
  assert.equal((await store.snapshot()).events.length, 1)
})

test('关闭等待已受理操作，同世界不能重复打开，关闭后可重新打开', async t => {
  const { store, root, fs } = await setup(t)
  await assert.rejects(HistoryStore.open({ fs, root, worldId: 'world', phase: 'initialization', access: 'read-write', singleWriterProcess: true }), { code: 'HISTORY_BUSY' })
  let release!: () => void; let enter!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }); const started = new Promise<void>(resolve => { enter = resolve })
  const write = fs.writeText.bind(fs)
  const mock = t.mock.method(fs, 'writeText', async (...args: Parameters<typeof write>) => { enter(); await gate; return write(...args) })
  const pending = store.create(data('排队')); await started
  const closing = store.close(); await assert.rejects(store.create(data('新请求')), { code: 'HISTORY_CLOSED' })
  release(); await pending; await closing; mock.mock.restore()
  const reopened = await HistoryStore.open({ fs, root, worldId: 'world', phase: 'initialization', access: 'read-only', singleWriterProcess: true })
  try { assert.equal((await reopened.snapshot()).events.length, 1); await assert.rejects(reopened.create(data('拒绝')), { code: 'HISTORY_FORBIDDEN' }) } finally { await reopened.close() }
})

test('引用解析器返回其他世界时拒绝写入及核验', async t => {
  const { store, root, fs } = await setup(t); await store.close()
  const other = await HistoryStore.open({ fs, root, worldId: 'world', phase: 'initialization', access: 'read-write', singleWriterProcess: true,
    resolvePlace: async value => ({ id: value, worldId: 'other' }) }); t.after(() => other.close())
  await assert.rejects(other.checkReference('place', id), { code: 'HISTORY_INVALID_DOCUMENT' })
  await assert.rejects(other.create({ ...data('历史'), references: [{ kind: 'linked', type: 'place', id, description: '' }] }), { code: 'HISTORY_INVALID_DOCUMENT' })
  assert.equal((await other.snapshot()).events.length, 0)
})
