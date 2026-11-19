import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test, type TestContext } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@fly-novel/fs-local'
import { SituationStore, type SituationInput } from '@fly-novel/initial-situation'

async function setup(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'situation-store-'))); t.after(() => rm(root, { recursive: true, force: true }))
  for (const folder of ['overviews', 'situations', 'candidates']) await mkdir(join(root, folder))
  const ctx = new Context(); const scope = await ctx.plugin(LocalFileSystem, { cwd: root }); t.after(() => scope.dispose())
  const store = await SituationStore.open({ fs: ctx.fs, root, worldId: 'world', phase: 'initialization', access: 'read-write', singleWriterProcess: true }); t.after(() => store.close())
  return { store, root, fs: ctx.fs }
}
const overview = { name: '城邦', summary: '', coverage: '河谷', reserved: [] }
const data = (overviewId: string, name: string): SituationInput => ({ overviewId, name, aliases: [], detailLevel: 'overview', summary: '', body: '', references: [], relations: [], reserved: [] })

test('世界只有一个起点，多个方案分别维护各自的局势', async t => {
  const { store } = await setup(t)
  const start = await store.createStart('战后，具体纪年未知'); await assert.rejects(store.createStart('另一时点'), { code: 'SITUATION_CONFLICT' })
  await store.updateStart(start.version, '战后，年份未知'); await assert.rejects(store.updateStart(start.version, '过期'), { code: 'SITUATION_CONFLICT' })
  const a = await store.createOverview(overview); const b = await store.createOverview(overview)
  const x = await store.createSituation(data(a.id, '供水')); const y = await store.createSituation(data(b.id, '供水'))
  await assert.rejects(store.createSituation({ ...data(a.id, '跨方案'), relations: [{ targetId: y.id, description: '不应关联' }] }), { code: 'SITUATION_INVALID_DOCUMENT' })
  const child = await store.createSituation({ ...data(a.id, '谈判'), relations: [{ targetId: x.id, description: '相关' }] })
  await store.update('situation', x.id, x.version, { ...data(a.id, '供水'), summary: '封渠' })
  assert.equal((await store.readSituation(y.id)).document.summary, '')
  await assert.rejects(store.update('situation', x.id, x.version, data(a.id, '过期')), { code: 'SITUATION_CONFLICT' })
  assert.equal((await store.readSituation(child.id)).document.relations[0]?.targetId, x.id)
  assert.equal((await store.snapshot()).overviews.length, 2)
})

test('确认资料只能准备候选并保留基线，损坏或跨世界文件不会被覆盖', async t => {
  const { store, root } = await setup(t); await store.createStart('起点'); const plan = await store.createOverview(overview)
  const path = join(root, plan.path); const original = await readFile(path, 'utf8'); await writeFile(path, original.replace('suggested', 'confirmed'))
  const current = await store.readOverview(plan.id)
  await assert.rejects(store.update('overview', plan.id, current.version, overview), { code: 'SITUATION_FORBIDDEN' })
  await store.prepare('overview', plan.id, current.version, { ...overview, summary: '候选' })
  assert.equal((await store.readCandidate('overview', plan.id)).stale, false)
  await assert.rejects(store.prepare('overview', plan.id, current.version, overview), { code: 'SITUATION_CONFLICT' })
  await writeFile(path, original.replace('suggested', 'confirmed').replace('城邦', '新城邦'))
  assert.equal((await store.readCandidate('overview', plan.id)).stale, true)
  for (const invalid of ['{"formatVersion":2}', original.replace('world', 'other'), '{broken', '{"formatVersion":1,"formatVersion":1}']) {
    await writeFile(path, invalid); await assert.rejects(store.readOverview(plan.id), { code: 'SITUATION_INVALID_DOCUMENT' }); assert.equal(await readFile(path, 'utf8'), invalid)
  }
})

test('取消和不确定发布不会盲目重复创建', async t => {
  const { store, root, fs } = await setup(t); await store.createStart('起点')
  const cancel = new AbortController(); cancel.abort(); await assert.rejects(store.createOverview(overview, cancel.signal))
  const write = fs.writeText.bind(fs); const mock = t.mock.method(fs, 'writeText', async (...args: Parameters<typeof write>) => { await write(...args); throw new Error('模拟发布后失败') })
  let path = ''; await assert.rejects(store.createOverview(overview), error => { assert.ok(error instanceof Error && 'code' in error && error.code === 'SITUATION_COMMIT_UNKNOWN' && 'path' in error && typeof error.path === 'string'); path = error.path; return true })
  mock.mock.restore(); assert.match(await readFile(join(root, path), 'utf8'), /城邦/); assert.equal((await store.snapshot()).overviews.length, 1)
})
