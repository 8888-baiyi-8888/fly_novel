import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@fly-novel/fs-local'
import { MapStore } from '@fly-novel/map'
import { parseSpecificJson, specificDocumentSchema, SpecificStore } from '@fly-novel/world-specific'
import { LlmAdapter, type GenerateOptions, type StreamChunk, type ToolCallId } from '@fly-novel/llm'
import { initializeCatalog } from '../../world-init/workspace/catalog/format.js'
import type { WorldWorkspaceConfig } from '../../world-init/workspace/config.js'
import configured = require('../call-llm.js')
import { createWorldSpecificResolver } from '../../world-init/storage/world-specific-references.js'
import { createWorldInitializationAgentWithWorldWorkspaces } from '../agents/index.js'

function call(id: string, name: string, args: object): StreamChunk { return { type: 'block-end', index: 0, block: { type: 'tool-call', id: id as ToolCallId, name, arguments: JSON.stringify(args) } } }
function result(options: GenerateOptions, id: string): Record<string, unknown> {
  const block = options.messages.flatMap(message => message.content).find(item => item.type === 'tool-result' && item.toolCallId === id); assert.ok(block && block.type === 'tool-result' && !block.isError, `${id}: ${JSON.stringify(block)}`)
  const value = block.content.find(item => item.type === 'text'); assert.ok(value && value.type === 'text'); const parsed: unknown = JSON.parse(value.text); assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed)); return Object.fromEntries(Object.entries(parsed))
}
class SpecificPlanner extends LlmAdapter {
  private step = 0; failure: unknown
  constructor(private readonly cultivation: boolean, private readonly placeId: string, private readonly placeVersion: string) { super() }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> { try { yield* this.execute(options) } catch (error) { this.failure = error; throw error } }
  private async *execute(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.step++
    const data = (name: string) => ({ name, aliases: [], detailLevel: 'overview', summary: '', body: '', reserved: ['远方未知'], topicIds: [], links: [], references: [] })
    const first = this.cultivation ? '修炼体系' : '潮汐航行'; const second = this.cultivation ? '特殊资源' : '船舶技术'; const item = this.cultivation ? '灵气规则' : '迷雾航行规则'
    if (this.step === 1) { yield call('background', 'read', { file_path: 'confirmed/background.md' }); yield call('place', 'map_place_read', { id: this.placeId }); yield call('existing', 'world_specific_topic_search', {}) }
    else if (this.step === 2) {
      const background = options.messages.flatMap(message => message.content).find(value => value.type === 'tool-result' && value.toolCallId === 'background'); assert.ok(background && background.type === 'tool-result' && !background.isError); assert.match(JSON.stringify(background.content), this.cultivation ? /灵气/ : /潮汐/)
      result(options, 'place'); assert.equal(result(options, 'existing').total, 0)
      yield call('a', 'world_specific_topic_create', { content: data(first) }); yield call('b', 'world_specific_topic_create', { content: data(second) })
    } else if (this.step === 3) {
      yield call('item', 'world_specific_item_create', { content: { ...data(item), topicIds: [result(options, 'a').id, result(options, 'b').id], references: [{ kind: 'linked', type: 'place', id: this.placeId, description: '相关地点', observedVersion: this.placeVersion }] } })
      yield call('catalog', 'catalog_register', { path: `specific/${result(options, 'a').path}`, summary: first })
    } else if (this.step === 4) {
      result(options, 'item'); result(options, 'catalog'); yield call('qa', 'world_specific_item_search', { topicId: result(options, 'a').id }); yield call('qb', 'world_specific_item_search', { topicId: result(options, 'b').id })
      yield call('update', 'world_specific_topic_update', { id: result(options, 'a').id, version: result(options, 'a').version, content: { ...data(first), summary: '补充已有规则' } })
    } else if (this.step === 5) {
      for (const id of ['qa', 'qb']) { const entries = result(options, id).items as Array<{ id: string; topicIds: string[] }>; assert.equal(entries[0]?.id, result(options, 'item').id); assert.equal(entries[0]?.topicIds.length, 2) }
      result(options, 'update'); yield call('stale', 'catalog_read', { path: `specific/${result(options, 'a').path}` })
    } else {
      assert.equal(result(options, 'stale').fileStatus, 'stale'); yield { type: 'block-end', index: 0, block: { type: 'text', text: `专有成果：specific/${result(options, 'item').path}` } }; yield { type: 'finish', reason: { kind: 'stop' } }; return
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}
class Parent extends LlmAdapter {
  private step = 0
  constructor(private readonly foreign: string, private readonly child: SpecificPlanner) { super() }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.step++
    if (this.step === 1) yield call('delegate', 'delegate_world_specific', { task: '读取已有资料，自主补充需要的专有规则并保留留白' })
    else if (this.step === 2) {
      const block = options.messages.flatMap(message => message.content).find(item => item.type === 'tool-result' && item.toolCallId === 'delegate'); assert.ok(block && block.type === 'tool-result' && !block.isError, `${JSON.stringify(block)}; 子任务：${String(this.child.failure)}`)
      const text = block.content.find(item => item.type === 'text'); assert.ok(text && text.type === 'text'); const path = text.text.match(/specific\/items\/[a-f0-9-]+\.json/); assert.ok(path); yield call('read', 'read', { file_path: path[0] })
    } else if (this.step === 3) {
      const block = options.messages.flatMap(message => message.content).find(item => item.type === 'tool-result' && item.toolCallId === 'read'); assert.ok(block && block.type === 'tool-result' && !block.isError); assert.match(JSON.stringify(block.content), /灵气规则|迷雾航行规则/); yield call('foreign', 'read', { file_path: this.foreign })
    } else {
      const block = options.messages.flatMap(message => message.content).find(item => item.type === 'tool-result' && item.toolCallId === 'foreign'); assert.ok(block && block.type === 'tool-result' && block.isError)
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '已核对专有内容' } }; yield { type: 'finish', reason: { kind: 'stop' } }; return
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}
test('修仙与航海世界经主 Agent 委派读取背景并保存专有内容', { timeout: 30000 }, async t => {
  const tmp = join(process.cwd(), 'tmp'); await mkdir(tmp, { recursive: true }); const root = await realpath(await mkdtemp(join(tmp, 'specific-e2e-'))); t.after(() => rm(root, { recursive: true, force: true }))
  const sessionRoot = join(root, 'sessions'); await mkdir(sessionRoot); const worlds: WorldWorkspaceConfig[] = []
  for (const worldId of ['cultivation', 'nautical']) {
    const readRoot = join(root, worldId); for (const folder of ['main', 'confirmed', 'catalog', 'map/places', 'map/connections', 'specific/topics', 'specific/items', 'specific/candidates']) await mkdir(join(readRoot, folder), { recursive: true })
    const world = { worldId, readRoot, confirmedRoot: join(readRoot, 'confirmed'), catalogRoot: join(readRoot, 'catalog'), mainAgent: { agentId: 'main', writableRoot: join(readRoot, 'main') }, agents: ['map', 'specific'].map(agentId => ({ agentId, writableRoot: join(readRoot, agentId) })) }
    await writeFile(join(world.confirmedRoot, 'background.md'), worldId === 'cultivation' ? '灵气背景' : '潮汐背景'); await writeFile(join(world.confirmedRoot, 'private.md'), worldId); await initializeCatalog(world.catalogRoot, worldId); worlds.push(world)
  }
  for (const [index, world] of worlds.entries()) {
    const ctx = new Context(); const fs = await ctx.plugin(LocalFileSystem, { cwd: world.readRoot }); const map = await MapStore.open({ fs: ctx.fs, root: join(world.readRoot, 'map'), worldId: world.worldId, access: 'read-write', singleWriterProcess: true })
    try {
      await map.createOverview({ name: '世界', description: '', scale: { width: 1000, height: 1000, unit: 'km' }, layers: [{ id: 'area', name: '地区' }], orientation: '北', reserved: [] })
      const place = await map.createPlace({ name: '重点地点', aliases: [], description: '', detailLevel: 'overview', reserved: [], parents: [{ layerId: 'area', parent: { kind: 'world' }, localBoxes: [[0, 0, 100, 100]], frameBox: [0, 0, 100, 100], coverage: 'complete' }] })
      const child = new SpecificPlanner(index === 0, place.id, place.version); const mock = t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'test', adapter: new Parent(join(worlds[1-index]!.confirmedRoot, 'private.md'), child) }))
      const parent = await createWorldInitializationAgentWithWorldWorkspaces(worlds, world.worldId, undefined, { singleWriterProcess: true, catalog: {}, worldSpecificAgent: { agentId: 'specific', sessionId: 's', sessionRoot, sessionMode: 'create', provider: 'test', model: 'test', adapter: child, references: { map: { agentId: 'map', store: map } } } })
      try { assert.deepEqual(await parent.run({ prompt: '按世界需要补充设定' }), { content: '已核对专有内容' }) } finally { await parent.dispose(); mock.mock.restore() }
      const directory = join(world.readRoot, 'specific/items'); const items = await Promise.all((await readdir(directory)).map(async name => parseSpecificJson(await readFile(join(directory, name), 'utf8'), specificDocumentSchema)))
      assert.equal(items.length, 1); assert.equal(items[0]?.topicIds.length, 2); assert.equal(items[0]?.contentStatus, 'suggested'); assert.ok(items[0]?.reserved.includes('远方未知'))
      const placePath = join(world.readRoot, 'map', place.path); const raw = await readFile(placePath, 'utf8'); await writeFile(placePath, raw.replace('"description": ""', '"description": "变化"'))
      const resolver = await createWorldSpecificResolver({ workspaces: worlds, worldId: world.worldId, map: { agentId: 'map', store: map } })
      const stored = await SpecificStore.open({ fs: ctx.fs, root: join(world.readRoot, 'specific'), worldId: world.worldId, phase: 'initialization', access: 'read-only', singleWriterProcess: true, resolveReference: resolver })
      try { assert.equal((await stored.checkReference('place', place.id, place.version)).status, 'changed') } finally { await stored.close() }
    } finally { await map.close(); await fs.dispose() }
  }
})
