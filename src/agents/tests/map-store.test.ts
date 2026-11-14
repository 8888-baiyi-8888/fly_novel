import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@fly-novel/fs-local'
import { MapStore, MapStoreError, parseMapPlace, parseWorldMap, type MapPlace, type WorldMap } from '@fly-novel/map'

const world: Omit<WorldMap, 'formatVersion' | 'worldId' | 'reviewStatus'> = {
  name: '河谷', description: '三座城邦', scale: { width: 10000, height: 4000, unit: 'km' },
  layers: [{ id: 'administrative', name: '城市划分' }, { id: 'geography', name: '山水地理' }], orientation: '上为北', reserved: ['外海留白'],
}
const rootParent: MapPlace['parents'][number] = { layerId: 'administrative', parent: { kind: 'world' },
  localBoxes: [[0, 0, 500, 1000]], frameBox: [0, 0, 500, 1000], coverage: 'complete' }
const place = (name: string, parents: MapPlace['parents'] = [rootParent]): Omit<MapPlace, 'formatVersion' | 'worldId' | 'id' | 'reviewStatus'> => ({
  name, aliases: [], description: '概况', detailLevel: 'overview', parents, reserved: [],
})

async function setup(t: TestContext) {
  const parent = join(process.cwd(), 'tmp'); await mkdir(parent, { recursive: true })
  const root = await realpath(await mkdtemp(join(parent, 'fly-map-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'places')); await mkdir(join(root, 'connections'))
  const ctx = new Context(); const scope = await ctx.plugin(LocalFileSystem, { cwd: root })
  t.after(() => scope.dispose())
  const config = { fs: ctx.fs as LocalFileSystem, root, worldId: 'city-world', access: 'read-write' as const, singleWriterProcess: true as const }
  const store = await MapStore.open(config)
  t.after(() => store.close())
  return { root, config, store }
}

test('地图 JSON 拒绝重复键、未知版本、无效坐标与重复父关联', () => {
  const valid = JSON.stringify({ ...world, formatVersion: 1, worldId: 'city-world', reviewStatus: 'suggested' })
  assert.equal(parseWorldMap(valid).name, '河谷')
  assert.throws(() => parseWorldMap(valid.replace('"width":10000', '"width":10000,"width":20000')), /重复键|无效结构/)
  assert.throws(() => parseWorldMap(valid.replace('"width":10000', '"width":10000,"\\u0077idth":20000')), /重复键|无效结构/)
  assert.throws(() => parseWorldMap(valid.replace('"formatVersion":1', '"formatVersion":2')))
  const candidate = { ...place('曲水城'), formatVersion: 1, worldId: 'city-world', id: '11111111-1111-4111-8111-111111111111', reviewStatus: 'suggested' }
  assert.equal(parseMapPlace(JSON.stringify(candidate)).name, '曲水城')
  for (const boxes of [[[0, 0, 0, 5]], [[0, 0, 1001, 5]], [[100, 0, 10, 5]]]) {
    assert.throws(() => parseMapPlace(JSON.stringify({ ...candidate, parents: [{ ...rootParent, localBoxes: boxes }] })))
  }
  assert.throws(() => parseMapPlace(JSON.stringify({ ...candidate, parents: [rootParent, rootParent] })))
  assert.throws(() => parseMapPlace(JSON.stringify({ ...candidate, parents: [{ ...rootParent, localBoxes: [], coverage: 'complete' }] })))
  assert.throws(() => parseMapPlace(JSON.stringify({ ...candidate, parents: [{ ...rootParent, frameBox: [0, 0, 0, 10] }] })))
  assert.throws(() => parseMapPlace(JSON.stringify({ ...candidate, parents: [{ ...rootParent, frameBox: [0, 0, 100, 100] }] })))
  assert.throws(() => parseMapPlace(JSON.stringify({ ...candidate, parents: [{ ...rootParent, parent: { kind: 'place', id: candidate.id } }] })))
})

test('真实文件保存多父级地点和连通，按版本更新并保护旧数据', async t => {
  const { root, store } = await setup(t)
  await assert.rejects(store.readOverview(), { code: 'MAP_NOT_FOUND' })
  const overview = await store.createOverview(world)
  await assert.rejects(store.createOverview(world), { code: 'MAP_CONFLICT' })
  assert.equal((await store.readOverview()).version, overview.version)
  const a = await store.createPlace(place('青河地区'))
  const b = await store.createPlace(place('白石地区'))
  const input = place('曲水城', [
    { layerId: 'administrative', parent: { kind: 'place', id: a.id }, localBoxes: [[800, 200, 1000, 600]], frameBox: [800, 200, 1200, 600], coverage: 'complete' },
    { layerId: 'administrative', parent: { kind: 'place', id: b.id }, localBoxes: [[0, 200, 200, 600]], frameBox: [-200, 200, 200, 600], coverage: 'complete' },
  ])
  const city = await store.createPlace(input)
  const found = await store.readPlace(city.id)
  assert.deepEqual(found.document.parents, input.parents)
  assert.equal(found.document.reviewStatus, 'suggested')
  const sameName = await store.createPlace(place('曲水城'))
  assert.notEqual(city.id, sameName.id)
  const route = await store.createConnection({ fromId: city.id, toId: sameName.id, direction: 'one-way', mode: '道路', description: '枯水可行' })
  const read = await store.readConnection(route.id)
  assert.equal(read.document.direction, 'one-way')
  const changed = await store.updateConnection(route.id, read.version, { fromId: city.id, toId: sameName.id, direction: 'two-way', mode: '道路', description: '全年可行' })
  await assert.rejects(store.updateConnection(route.id, read.version, { fromId: city.id, toId: sameName.id, direction: 'one-way', mode: '道路', description: '过期' }), { code: 'MAP_CONFLICT' })
  assert.equal((await store.readConnection(route.id)).version, changed.version)
  const text = await readFile(join(root, route.path), 'utf8')
  assert.match(text, /two-way/)
  assert.doesNotMatch(text, /reviewStatus|source/)
  assert.equal((await readdir(join(root, 'places'))).length, 4)
})

test('拒绝未知层面、缺失和未展开父级及跨世界数据，不改写文件', async t => {
  const { root, store } = await setup(t)
  await store.createOverview(world)
  const before = await readFile(join(root, 'map.json'), 'utf8')
  await assert.rejects(store.createPlace(place('错误层面', [{ ...rootParent, layerId: 'unknown' }])), { code: 'MAP_INVALID_DOCUMENT' })
  await assert.rejects(store.createPlace(place('缺失父级', [{ ...rootParent, parent: { kind: 'place', id: '33333333-3333-4333-8333-333333333333' } }])), { code: 'MAP_INVALID_DOCUMENT' })
  const shallow = await store.createPlace({ ...place('未展开'), detailLevel: 'unexpanded' })
  await assert.rejects(store.createPlace(place('子地点', [{ ...rootParent, parent: { kind: 'place', id: shallow.id } }])), { code: 'MAP_INVALID_DOCUMENT' })
  const badId = '44444444-4444-4444-8444-444444444444'
  const bad = { ...place('其他世界'), formatVersion: 1, worldId: 'other-world', id: badId, reviewStatus: 'suggested' }
  const path = join(root, 'places', `${badId}.json`)
  await writeFile(path, JSON.stringify(bad))
  await assert.rejects(store.createPlace(place('不应创建')), { code: 'MAP_INVALID_DOCUMENT' })
  assert.equal(await readFile(path, 'utf8'), JSON.stringify(bad))
  assert.equal(await readFile(join(root, 'map.json'), 'utf8'), before)
})

test('损坏文档、重复 ID 和父级环被拒绝并保留原文', async t => {
  const { root, store } = await setup(t)
  await store.createOverview(world)
  const a = '11111111-1111-4111-8111-111111111111'; const b = '22222222-2222-4222-8222-222222222222'
  const doc = (id: string, parent: string) => ({ ...place('地点', [{ ...rootParent, parent: { kind: 'place', id: parent } }]),
    formatVersion: 1, worldId: 'city-world', id, reviewStatus: 'suggested' })
  await writeFile(join(root, 'places', `${a}.json`), JSON.stringify(doc(a, b)))
  await writeFile(join(root, 'places', `${b}.json`), JSON.stringify(doc(b, a)))
  await assert.rejects(store.readPlace(a), { code: 'MAP_INVALID_DOCUMENT' })
  const before = await readFile(join(root, 'places', `${a}.json`), 'utf8')
  await writeFile(join(root, 'places', `${b}.json`), JSON.stringify({ ...doc(b, a), id: a }))
  await assert.rejects(store.readPlace(a), { code: 'MAP_INVALID_DOCUMENT' })
  await writeFile(join(root, 'places', `${b}.json`), '{"formatVersion":1,"formatVersion":1}')
  await assert.rejects(store.readPlace(a), { code: 'MAP_INVALID_DOCUMENT' })
  assert.equal(await readFile(join(root, 'places', `${a}.json`), 'utf8'), before)
})

test('未知版本和非法 JSON 被拒绝且保留原文件', async t => {
  const { root, store } = await setup(t)
  await store.createOverview(world)
  const path = join(root, 'map.json')
  const current = await readFile(path, 'utf8')
  for (const invalid of [current.replace('"formatVersion": 1', '"formatVersion": 2'), '{invalid json']) {
    await writeFile(path, invalid)
    await assert.rejects(store.readOverview(), { code: 'MAP_INVALID_DOCUMENT' })
    assert.equal(await readFile(path, 'utf8'), invalid)
  }
})

test('只读和身份占用不允许写入，关闭后可重新打开', async t => {
  const { config, store } = await setup(t)
  await assert.rejects(MapStore.open(config), { code: 'MAP_BUSY' })
  await store.createOverview(world)
  await Promise.all([store.close(), store.close()])
  await assert.rejects(store.readOverview(), { code: 'MAP_CLOSED' })
  const reader = await MapStore.open({ ...config, access: 'read-only' })
  try {
    assert.equal((await reader.readOverview()).document.worldId, 'city-world')
    await assert.rejects(reader.createPlace(place('拒绝写入')), { code: 'MAP_FORBIDDEN' })
  } finally { await reader.close() }
})

test('读取大小受限且不截断、修改已有地图文件', async t => {
  const { root, config, store } = await setup(t)
  await store.createOverview(world)
  const before = await readFile(join(root, 'map.json'), 'utf8')
  await store.close()
  const limited = await MapStore.open({ ...config, access: 'read-only', maxDocumentBytes: 16 })
  try { await assert.rejects(limited.readOverview(), { code: 'FS_TOO_LARGE' }) }
  finally { await limited.close() }
  assert.equal(await readFile(join(root, 'map.json'), 'utf8'), before)
})

test('发布结果不确定时保留核查路径及实际成果', async t => {
  const { root, config, store } = await setup(t)
  await store.createOverview(world)
  const write = config.fs.writeText.bind(config.fs)
  t.mock.method(config.fs, 'writeText', async (...args: Parameters<typeof write>) => { await write(...args); throw new Error('模拟提交后失败') })
  let caught: unknown
  try { await store.createPlace(place('群岛')) } catch (error) { caught = error }
  assert.ok(caught instanceof MapStoreError && caught.code === 'MAP_COMMIT_UNKNOWN' && caught.path)
  assert.match(await readFile(join(root, caught.path), 'utf8'), /群岛/)
})

test('取消未发布的写入不创建文件，关闭等待已受理操作', async t => {
  const { root, config, store } = await setup(t)
  await store.createOverview(world)
  const controller = new AbortController()
  config.fs.internals.inspectTemp = () => controller.abort()
  await assert.rejects(store.createPlace(place('取消'), controller.signal), { code: 'FS_ABORTED' })
  delete config.fs.internals.inspectTemp
  assert.deepEqual(await readdir(join(root, 'places')), [])

  let entered!: () => void; let release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const proceed = new Promise<void>(resolve => { release = resolve })
  config.fs.internals.inspectTemp = async () => { entered(); await proceed }
  const pending = store.createPlace(place('保留'))
  await started
  let closed = false
  const closing = store.close().then(() => { closed = true })
  await assert.rejects(store.readOverview(), { code: 'MAP_CLOSED' })
  assert.equal(closed, false)
  release()
  const created = await pending
  await closing
  assert.match(await readFile(join(root, created.path), 'utf8'), /保留/)
  delete config.fs.internals.inspectTemp
})

test('拒绝将地点目录中的符号链接作为地图文档', async t => {
  const { root, store } = await setup(t)
  await store.createOverview(world)
  const external = join(root, 'map.json')
  const original = await readFile(external, 'utf8')
  const link = join(root, 'places', '11111111-1111-4111-8111-111111111111.json')
  try { await symlink(external, link, 'file'); t.diagnostic('使用真实文件符号链接') }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && ['EPERM', 'EACCES', 'ENOTSUP'].includes(String(error.code)))) throw error
    const externalDirectory = join(root, 'external-directory')
    await mkdir(externalDirectory)
    await writeFile(join(externalDirectory, 'preserved.txt'), 'preserved')
    await symlink(externalDirectory, link, process.platform === 'win32' ? 'junction' : 'dir')
    t.diagnostic('使用真实目录链接验证链接边界')
  }
  await assert.rejects(store.createPlace(place('不能绕过边界')), { code: 'MAP_FORBIDDEN' })
  assert.equal(await readFile(external, 'utf8'), original)
})
