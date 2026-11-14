import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@fly-novel/fs-local'
import { createMapTools, MapQueries, MapStore, type MapPlace } from '@fly-novel/map'
import { ToolsService, type ToolRunContext } from '@fly-novel/tools'
import type { ToolCallId } from '@fly-novel/llm'

async function setup(t: TestContext) {
  await mkdir(join(process.cwd(), 'tmp'), { recursive: true })
  const root = await realpath(await mkdtemp(join(process.cwd(), 'tmp', 'map-query-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'places')); await mkdir(join(root, 'connections'))
  const ctx = new Context(); const scope = await ctx.plugin(LocalFileSystem, { cwd: root }); t.after(() => scope.dispose())
  const store = await MapStore.open({ fs: ctx.fs, root, worldId: 'query-world', access: 'read-write', singleWriterProcess: true }); t.after(() => store.close())
  await store.createOverview({ name: '河谷', description: '', scale: { width: 10000, height: 4000, unit: 'km' }, layers: [{ id: 'city', name: '城市' }], orientation: '北', reserved: [] })
  const create = (name: string, parents: MapPlace['parents']) => store.createPlace({ name, aliases: [], description: '', detailLevel: 'overview', parents, reserved: [] })
  const rootEdge = (frameBox: [number, number, number, number]): MapPlace['parents'][number] => ({ layerId: 'city', parent: { kind: 'world' }, localBoxes: [frameBox], frameBox, coverage: 'complete' })
  const a = await create('青河', [rootEdge([0, 0, 500, 1000])]); const b = await create('白石', [rootEdge([500, 0, 1000, 1000])])
  const city = await create('曲水城', [
    { layerId: 'city', parent: { kind: 'place', id: a.id }, localBoxes: [[800, 200, 1000, 600]], frameBox: [800, 200, 1200, 600], coverage: 'complete' },
    { layerId: 'city', parent: { kind: 'place', id: b.id }, localBoxes: [[0, 200, 200, 600]], frameBox: [-200, 200, 200, 600], coverage: 'complete' },
  ])
  return { store, queries: new MapQueries(store), a, b, city }
}

test('多父级地点查询和逐层坐标保留同一 ID 与其他父级', async t => {
  const { queries, a, b, city } = await setup(t)
  const result = await queries.children({ id: a.id, layerId: 'city', depth: 1, offset: 0, limit: 20 })
  assert.equal(result.items[0].id, city.id)
  assert.equal(result.items[0].parents.length, 2)
  const point = await queries.coordinates({ id: city.id, layerId: 'city', path: [a.id, 'world'], mode: 'coverage' })
  assert.deepEqual(point.boxes, [[400, 200, 500, 600]])
  assert.ok('physicalBoxes' in point)
  assert.deepEqual(point.physicalBoxes, [[4000, 800, 5000, 2400]])
  assert.equal(point.consistency, 'consistent')
  const other = await queries.coordinates({ id: city.id, layerId: 'city', path: [b.id, 'world'], mode: 'coverage' })
  assert.deepEqual(other.boxes, [[500, 200, 600, 600]])
  const ancestors = await queries.ancestors({ id: city.id, layerId: 'city', depth: 2, offset: 0, limit: 20 })
  assert.equal(ancestors.items.filter(item => item.id === 'world').length, 2)
})

test('区域搜索按实际范围，连通查询区分单向并拒绝过期分页', async t => {
  const { queries, store, a, b, city } = await setup(t)
  const search = await queries.area({ layerId: 'city', canvas: 'world', boxes: [[450, 300, 550, 400]], includeTouching: false, offset: 0, limit: 20 })
  assert.ok(search.items.some(item => item.id === city.id))
  const initial = await queries.search({ offset: 0, limit: 1 })
  const next = await queries.search({ offset: 1, limit: 1, version: initial.version })
  assert.equal(next.items.length, 1)
  await store.createConnection({ fromId: a.id, toId: b.id, direction: 'one-way', mode: '道路', description: '' })
  await assert.rejects(queries.search({ offset: 1, limit: 1, version: initial.version }), { code: 'MAP_CONFLICT' })
  assert.equal((await queries.connections({ id: b.id, direction: 'out', offset: 0, limit: 20 })).items.length, 0)
  assert.equal((await queries.connections({ id: b.id, direction: 'in', offset: 0, limit: 20 })).items.length, 1)
})

test('范围未知和取消不会冒充完整查询结果', async t => {
  const { queries, store } = await setup(t)
  await store.createPlace({ name: '未定位', aliases: [], description: '', detailLevel: 'unexpanded', reserved: [], parents: [{ layerId: 'city', parent: { kind: 'world' }, localBoxes: [], frameBox: null, coverage: 'partial' }] })
  const area = await queries.area({ layerId: 'city', canvas: 'world', boxes: [[0, 0, 100, 100]], includeTouching: false, offset: 0, limit: 20 })
  assert.equal(area.complete, false)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(queries.search({ offset: 0, limit: 20 }, controller.signal))
})

test('地图工具在包内定义并绑定身份，只读模式不暴露写工具', async t => {
  const { store, a } = await setup(t)
  const identity = { id: 'map-agent', name: '地图', role: 'map' }
  const tools = createMapTools(store, identity, 'read-only')
  assert.equal(tools.some(tool => tool.name === 'map_place_create'), false)
  const read = tools.find(tool => tool.name === 'map_place_read')!
  const context = { agent: identity, signal: new AbortController().signal } as ToolRunContext
  const result = await read.execute({ id: a.id }, context)
  assert.equal((result as { document: { id: string } }).document.id, a.id)
  await assert.rejects(read.execute({ id: a.id }, { ...context, agent: { ...identity } }), { code: 'MAP_FORBIDDEN' })
  assert.equal(createMapTools(store, identity, 'read-write').some(tool => tool.name === 'map_place_create'), true)
  const create = createMapTools(store, identity, 'read-write').find(tool => tool.name === 'map_place_create')!
  const created = await create.execute({ name: '测试村', aliases: [], description: '', detailLevel: 'overview', parents: [{ layerId: 'city', parent: { kind: 'place', id: a.id }, localBoxes: [[0, 0, 20, 20]], frameBox: [0, 0, 20, 20], coverage: 'complete' }], reserved: [] }, context)
  assert.equal((await store.readPlace((created as { id: string }).id)).document.name, '测试村')
})

test('工具服务注册地图工具并通过真实调用读取资料', async t => {
  const { store, city } = await setup(t)
  const service = new ToolsService({ id: 'map-agent', name: '地图', role: 'map' })
  t.after(() => service.dispose())
  assert.ok(service.agent)
  for (const tool of createMapTools(store, service.agent, 'read-only')) service.register(tool)
  const call = async (args: object) => (await service.execute({ calls: [{ type: 'tool-call', id: 'map-read' as ToolCallId, name: 'map_place_read', arguments: JSON.stringify(args) }], workingDirectory: '.', signal: new AbortController().signal })).results[0].result
  const result = await call({ id: city.id })
  assert.equal(result.isError, false)
  if (result.isError || !result.value || typeof result.value !== 'object' || Array.isArray(result.value)) throw new Error('读取结果无效')
  assert.equal(typeof result.value.document, 'object')
  assert.equal((await call({ id: city.id, worldId: 'other' })).isError, true)
})

test('分离矩形的空隙不命中，边缘接触单独报告', async t => {
  const { queries, store } = await setup(t)
  const island = await store.createPlace({ name: '群岛', aliases: [], description: '', detailLevel: 'overview', reserved: [], parents: [{ layerId: 'city', parent: { kind: 'world' }, localBoxes: [[100, 100, 200, 200], [300, 100, 400, 200]], frameBox: [100, 100, 400, 200], coverage: 'complete' }] })
  const gap = await queries.area({ layerId: 'city', canvas: 'world', boxes: [[210, 120, 290, 180]], includeTouching: false, offset: 0, limit: 20 })
  assert.equal(gap.items.some(item => item.id === island.id), false)
  const edge = await queries.area({ layerId: 'city', canvas: 'world', boxes: [[200, 120, 210, 180]], includeTouching: true, offset: 0, limit: 20 })
  assert.equal(edge.items.find(item => item.id === island.id)?.relation, 'touching')
})

test('不同父级路径画布位置冲突时拒绝选择，分页条件变化也拒绝', async t => {
  const { queries, store, a, b } = await setup(t)
  const invalid = await store.createPlace({ name: '位置冲突', aliases: [], description: '', detailLevel: 'overview', reserved: [], parents: [
    { layerId: 'city', parent: { kind: 'place', id: a.id }, localBoxes: [[800, 200, 1000, 600]], frameBox: [800, 200, 1200, 600], coverage: 'complete' },
    { layerId: 'city', parent: { kind: 'place', id: b.id }, localBoxes: [[0, 200, 200, 600]], frameBox: [-100, 200, 200, 600], coverage: 'complete' },
  ] })
  await assert.rejects(queries.coordinates({ id: invalid.id, layerId: 'city', path: [a.id, 'world'], mode: 'coverage' }), { code: 'MAP_CONFLICT' })
  const first = await queries.search({ offset: 0, limit: 1 })
  await assert.rejects(queries.search({ offset: 1, limit: 1, keyword: '青', version: first.version }), { code: 'MAP_CONFLICT' })
})
