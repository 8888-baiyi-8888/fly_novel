import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { LlmAdapter, type GenerateOptions, type StreamChunk, type ToolCallId } from '@fly-novel/llm'
import configured = require('../call-llm.js')
import { createWorldInitializationAgentWithWorldWorkspaces } from '../agents/index.js'
import { initializeCatalog } from '../../world-init/workspace/catalog/format.js'

function call(id: string, name: string, args: object): StreamChunk {
  return { type: 'block-end', index: 0, block: { type: 'tool-call', id: id as ToolCallId, name, arguments: JSON.stringify(args) } }
}
function result(options: GenerateOptions, id: string) {
  const value = options.messages.flatMap(message => message.content).find(block => block.type === 'tool-result' && block.toolCallId === id)
  assert.ok(value && value.type === 'tool-result' && !value.isError, `工具 ${id} 失败：${JSON.stringify(value)}`)
  const content = value.content.find(block => block.type === 'text')
  assert.ok(content && content.type === 'text')
  return content.text
}
function parsed(options: GenerateOptions, id: string): Record<string, unknown> {
  const value: unknown = JSON.parse(result(options, id))
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  return Object.fromEntries(Object.entries(value))
}
function object(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  return Object.fromEntries(Object.entries(value))
}

class MapAdapter extends LlmAdapter {
  private step = 0
  constructor(private readonly city: boolean) { super() }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.step++
    const rootName = this.city ? '河谷城邦群' : '青岚修仙世界'
    const regionName = this.city ? '青河地区' : '青岚山域'
    const names = this.city ? ['曲水城', '曲水城'] : ['青云坊', '青云坊']
    const edge = { layerId: 'area', parent: { kind: 'world' }, localBoxes: [[0, 0, 500, 1000]], frameBox: [0, 0, 500, 1000], coverage: 'complete' }
    if (this.step === 1) yield call('overview', 'map_overview_create', { name: rootName, description: '世界范围', scale: { width: 10000, height: 4000, unit: 'km' }, layers: [{ id: 'area', name: '地区' }], orientation: '上为北', reserved: [this.city ? '外海' : '远方群山'] })
    else if (this.step === 2) { result(options, 'overview'); yield call('region', 'map_place_create', { name: regionName, aliases: [], description: '父地区概况', detailLevel: 'overview', parents: [edge], reserved: [] }) }
    else if (this.step === 3) {
      const region = parsed(options, 'region'); assert.equal(typeof region.id, 'string')
      for (const [index, name] of names.entries()) {
        const frame = index === 0 ? [100, 100, 300, 300] : [600, 600, 800, 800]
        yield call(index === 0 ? 'one' : 'two', 'map_place_create', { name, aliases: [], description: index === 0 ? '近期故事地点' : '同名远处地点', detailLevel: 'overview', reserved: [], parents: [{ layerId: 'area', parent: { kind: 'place', id: region.id }, localBoxes: [frame], frameBox: frame, coverage: 'complete' }] })
      }
    } else if (this.step === 4) { result(options, 'two'); yield call('search', 'map_place_search', { keyword: names[0] }) }
    else if (this.step === 5) {
      const matches = parsed(options, 'search').items; assert.ok(Array.isArray(matches)); assert.equal(matches.length, 2)
      assert.ok(matches.some(match => object(match).id === parsed(options, 'one').id))
      yield call('read', 'map_place_read', { id: parsed(options, 'one').id })
      yield call('coordinates', 'map_coordinates_convert', { id: parsed(options, 'one').id, layerId: 'area', path: [parsed(options, 'region').id, 'world'], mode: 'coverage' })
    } else if (this.step === 6) {
      assert.equal(object(parsed(options, 'read').document).name, names[0])
      assert.deepEqual(parsed(options, 'coordinates').boxes, [[50, 100, 150, 300]])
      yield call('connection', 'map_connection_create', { fromId: parsed(options, 'one').id, toId: parsed(options, 'two').id, direction: 'one-way', mode: this.city ? '河路' : '山道', description: '初始通路' })
    } else if (this.step === 7) { result(options, 'connection'); yield call('connections', 'map_connections_read', { id: parsed(options, 'one').id }) }
    else if (this.step === 8) {
      const items = parsed(options, 'connections').items; assert.ok(Array.isArray(items)); assert.equal(items.length, 1)
      const entry = object(items[0]); const document = object(entry.document)
      yield call('update', 'map_connection_update', { id: document.id, version: entry.version, content: { fromId: document.fromId, toId: document.toId, direction: 'two-way', mode: document.mode, description: '更新后的通路' } })
    } else if (this.step === 9) {
      result(options, 'update'); yield call('verify', 'map_connections_read', { id: parsed(options, 'one').id })
      yield call('catalog', 'catalog_register', { path: 'map/map.json', summary: rootName })
    } else {
      result(options, 'catalog')
      const items = parsed(options, 'verify').items; assert.ok(Array.isArray(items)); assert.equal(object(object(items[0]).document).direction, 'two-way')
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '地图资料：map/map.json' } }
      yield { type: 'finish', reason: { kind: 'stop' } }; return
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

class ParentAdapter extends LlmAdapter {
  private step = 0
  constructor(private readonly city: boolean, private readonly foreignPath: string) { super() }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.step++
    if (this.step === 1) yield call('delegate', 'delegate_map', { task: this.city ? '规划近期城邦，外海留白' : '规划近期修仙地点，远山留白' })
    else if (this.step === 2) { assert.match(result(options, 'delegate'), /map\/map.json/); yield call('read-map', 'read', { file_path: 'map/map.json' }) }
    else if (this.step === 3) { assert.match(result(options, 'read-map'), this.city ? /河谷城邦群/ : /青岚修仙世界/); yield call('foreign', 'read', { file_path: this.foreignPath }) }
    else {
      const block = options.messages.flatMap(message => message.content).find(item => item.type === 'tool-result' && item.toolCallId === 'foreign')
      assert.ok(block && block.type === 'tool-result' && block.isError)
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '已核对地图' } }
      yield { type: 'finish', reason: { kind: 'stop' } }; return
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

test('修仙世界和城邦群通过主 Agent 委派并核对地图成果', { timeout: 30000 }, async t => {
  const temp = join(process.cwd(), 'tmp'); await mkdir(temp, { recursive: true })
  const root = await realpath(await mkdtemp(join(temp, 'map-e2e-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sessionRoot = join(root, 'sessions'); await mkdir(sessionRoot)
  const worlds = []
  for (const name of ['cultivation', 'city']) {
    const readRoot = join(root, name)
    for (const dir of ['main', 'map/places', 'map/connections', 'confirmed', 'catalog']) await mkdir(join(readRoot, dir), { recursive: true })
    const world = { worldId: name, readRoot, confirmedRoot: join(readRoot, 'confirmed'), catalogRoot: join(readRoot, 'catalog'),
      mainAgent: { agentId: 'main', writableRoot: join(readRoot, 'main') }, agents: [{ agentId: 'map', writableRoot: join(readRoot, 'map') }] }
    await writeFile(join(world.confirmedRoot, 'private.md'), `${name} 的世界资料`)
    await initializeCatalog(world.catalogRoot, world.worldId); worlds.push(world)
  }
  for (const [index, world] of worlds.entries()) {
    const city = index === 1; const foreign = worlds[1-index]
    const mock = t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'test', adapter: new ParentAdapter(city, join(foreign.confirmedRoot, 'private.md')) }))
    const parent = await createWorldInitializationAgentWithWorldWorkspaces(worlds, world.worldId, undefined, { singleWriterProcess: true, catalog: {},
      mapAgent: { agentId: 'map', sessionId: 's', sessionMode: 'create', sessionRoot, provider: 'test', model: 'test', adapter: new MapAdapter(city) } })
    try {
      assert.deepEqual(await parent.run({ prompt: city ? '规划城邦群' : '规划修仙世界' }), { content: '已核对地图' })
      const data: unknown = JSON.parse(await readFile(join(world.readRoot, 'map', 'map.json'), 'utf8'))
      assert.deepEqual(object(data).reserved, [city ? '外海' : '远方群山'])
      assert.match(await readFile(join(world.catalogRoot, 'catalog.json'), 'utf8'), city ? /河谷城邦群/ : /青岚修仙世界/)
    } finally { await parent.dispose(); mock.mock.restore() }
  }
})
