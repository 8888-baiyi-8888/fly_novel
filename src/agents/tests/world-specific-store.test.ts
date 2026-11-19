import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test, type TestContext } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@fly-novel/fs-local'
import { SpecificStore, type SpecificContent } from '@fly-novel/world-specific'

const data = (name: string): SpecificContent => ({ name, aliases: [], detailLevel: 'overview', summary: '', body: '', reserved: [], topicIds: [], links: [], references: [] })
async function setup(t: TestContext, worldId = 'world') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'world-specific-'))); t.after(() => rm(root, { recursive: true, force: true }))
  for (const folder of ['topics', 'items', 'candidates']) await mkdir(join(root, folder))
  const context = new Context(); const scope = await context.plugin(LocalFileSystem, { cwd: root }); t.after(() => scope.dispose())
  const store = await SpecificStore.open({ fs: context.fs, root, worldId, phase: 'initialization', access: 'read-write', singleWriterProcess: true }); t.after(() => store.close())
  return { store, root, context }
}
test('独立内容可同时关联多个主题，同名主题和世界身份不混同', async t => {
  const one = await setup(t, 'one'); const two = await setup(t, 'two')
  const a = await one.store.create('topic', data('修炼')); const b = await one.store.create('topic', data('交易')); const duplicate = await one.store.create('topic', data('修炼'))
  const other = await two.store.create('topic', data('修炼')); assert.notEqual(a.id, duplicate.id)
  const content = { ...data('灵石'), topicIds: [a.id, b.id], body: '一份规则' }; const item = await one.store.create('item', content)
  assert.deepEqual((await one.store.readDocument('item', item.id)).document.topicIds, [a.id, b.id])
  await assert.rejects(one.store.create('item', { ...content, topicIds: [other.id] }), { code: 'SPECIFIC_INVALID_DOCUMENT' })
  await assert.rejects(one.store.create('item', { ...content, topicIds: [a.id, a.id] }))
  const updated = await one.store.update('item', item.id, item.version, { ...content, summary: '补充规则' }); assert.ok(updated.version)
  assert.equal((await one.store.readDocument('item', item.id)).document.body, '一份规则')
  await assert.rejects(one.store.update('item', item.id, item.version, content), { code: 'SPECIFIC_CONFLICT' })
})
test('确认内容使用候选，损坏、未知版本及跨世界拒绝并保留原文', async t => {
  const { store, root } = await setup(t); const created = await store.create('topic', data('修炼')); const path = join(root, created.path); const raw = await readFile(path, 'utf8')
  await writeFile(path, raw.replace('suggested', 'confirmed')); const old = await store.readDocument('topic', created.id)
  await assert.rejects(store.update('topic', created.id, old.version, data('覆盖')), { code: 'SPECIFIC_FORBIDDEN' })
  await store.prepare('topic', created.id, old.version, data('候选')); assert.equal((await store.readCandidate('topic', created.id)).stale, false)
  await assert.rejects(store.prepare('topic', created.id, old.version, data('再次候选')), { code: 'SPECIFIC_CONFLICT' })
  await writeFile(path, raw.replace('suggested', 'confirmed').replace('修炼', '修炼体系')); assert.equal((await store.readCandidate('topic', created.id)).stale, true)
  for (const invalid of ['{"formatVersion":2}', raw.replace('world', 'other'), '{broken', '{"formatVersion":1,"formatVersion":1}']) { await writeFile(path, invalid); await assert.rejects(store.readDocument('topic', created.id), { code: 'SPECIFIC_INVALID_DOCUMENT' }); assert.equal(await readFile(path, 'utf8'), invalid) }
})
test('取消和结果不确定时保留实际成果', async t => {
  const { store, root, context } = await setup(t); const abort = new AbortController(); abort.abort(); await assert.rejects(store.create('topic', data('取消'), abort.signal))
  const write = context.fs.writeText.bind(context.fs); const mock = t.mock.method(context.fs, 'writeText', async (...args: Parameters<typeof write>) => { await write(...args); throw new Error('模拟发布后失败') })
  let path = ''; await assert.rejects(store.create('topic', data('已发布')), error => { assert.ok(error instanceof Error && 'code' in error && error.code === 'SPECIFIC_COMMIT_UNKNOWN' && 'path' in error && typeof error.path === 'string'); path = error.path; return true }); mock.mock.restore()
  assert.match(await readFile(join(root, path), 'utf8'), /已发布/); assert.equal((await store.snapshot()).items.length, 1)
})
test('只读存储拒绝写入并保留现有文件', async t => {
  const { store, root, context } = await setup(t); const created = await store.create('topic', data('航行')); await store.close()
  const readonly = await SpecificStore.open({ fs: context.fs, root, worldId: 'world', phase: 'initialization', access: 'read-only', singleWriterProcess: true }); t.after(() => readonly.close())
  await assert.rejects(readonly.create('topic', data('写入')), { code: 'SPECIFIC_FORBIDDEN' }); assert.equal((await readonly.readDocument('topic', created.id)).document.name, '航行')
})
