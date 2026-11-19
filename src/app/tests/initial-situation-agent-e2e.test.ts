import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { LlmAdapter, type GenerateOptions, type StreamChunk, type ToolCallId } from '@fly-novel/llm'
import { situationSchema, parseJson } from '@fly-novel/initial-situation'
import { initializeCatalog } from '../../world-init/workspace/catalog/format.js'
import type { WorldWorkspaceConfig } from '../../world-init/workspace/config.js'
import configured = require('../call-llm.js')
import { createWorldInitializationAgentWithWorldWorkspaces } from '../agents/index.js'

function call(id: string, name: string, args: object): StreamChunk { return { type: 'block-end', index: 0, block: { type: 'tool-call', id: id as ToolCallId, name, arguments: JSON.stringify(args) } } }
function result(options: GenerateOptions, id: string): Record<string, unknown> {
  const block = options.messages.flatMap(message => message.content).find(item => item.type === 'tool-result' && item.toolCallId === id)
  assert.ok(block && block.type === 'tool-result' && !block.isError, `${id}: ${JSON.stringify(block)}`)
  const text = block.content.find(item => item.type === 'text'); assert.ok(text && text.type === 'text')
  const parsed: unknown = JSON.parse(text.text); assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed)); return Object.fromEntries(Object.entries(parsed))
}
class Planner extends LlmAdapter {
  private step = 0; failure: unknown
  constructor(private readonly city: boolean) { super() }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> { try { yield* this.execute(options) } catch (error) { this.failure = error; throw error } }
  private async *execute(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.step++
    const base = (name: string) => ({ name, summary: '初始处境', coverage: this.city ? '河谷' : '山门附近', reserved: ['远方未知'] })
    const content = (overviewId: unknown, name: string) => ({ overviewId, name, aliases: [], detailLevel: 'overview', summary: '当前紧张', body: '', references: [{ kind: 'unresolved', type: 'history', description: '待核实的旧事' }], relations: [], reserved: ['后续发展未知'] })
    if (this.step === 1) yield call('start', 'situation_start_create', { description: '世界演化起点，纪年未知' })
    else if (this.step === 2) { result(options, 'start'); yield call('a', 'situation_overview_create', { content: base('方案甲') }); yield call('b', 'situation_overview_create', { content: base('方案乙') }) }
    else if (this.step === 3) {
      yield call('first', 'situation_create', { content: content(result(options, 'a').id, this.city ? '上游封渠' : '灵气紧张') })
      yield call('other', 'situation_create', { content: content(result(options, 'b').id, this.city ? '暂时通水' : '暂时协商') })
    } else if (this.step === 4) {
      yield call('second', 'situation_create', { content: { ...content(result(options, 'a').id, this.city ? '下游抗议' : '争用资源'), relations: [{ targetId: result(options, 'first').id, description: '相互关联' }] } })
      yield call('catalog', 'catalog_register', { path: `situation/${result(options, 'first').path}`, summary: '当前局势' })
    } else if (this.step === 5) {
      result(options, 'second'); result(options, 'other'); result(options, 'catalog')
      yield call('search', 'situation_search', { overviewId: result(options, 'a').id })
      yield call('related', 'situation_related_read', { id: result(options, 'first').id })
    } else if (this.step === 6) {
      assert.equal(result(options, 'search').total, 2); assert.match(JSON.stringify(result(options, 'related')), /相互关联/)
      yield call('update', 'situation_update', { kind: 'situation', id: result(options, 'first').id, version: result(options, 'first').version, content: { ...content(result(options, 'a').id, this.city ? '上游封渠' : '灵气紧张'), summary: '已补充影响' } })
    } else if (this.step === 7) { result(options, 'update'); yield call('stale', 'catalog_read', { path: `situation/${result(options, 'first').path}` }) }
    else {
      assert.equal(result(options, 'stale').fileStatus, 'stale')
      yield { type: 'block-end', index: 0, block: { type: 'text', text: `局势成果：situation/${result(options, 'first').path}` } }; yield { type: 'finish', reason: { kind: 'stop' } }; return
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}
class Parent extends LlmAdapter {
  private step = 0
  constructor(private readonly foreign: string, private readonly child: Planner) { super() }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.step++
    if (this.step === 1) yield call('delegate', 'delegate_initial_situation', { task: '规划近期局势，保留未知' })
    else if (this.step === 2) {
      const block = options.messages.flatMap(m => m.content).find(item => item.type === 'tool-result' && item.toolCallId === 'delegate')
      assert.ok(block && block.type === 'tool-result' && !block.isError, `${JSON.stringify(block)}; 子任务：${String(this.child.failure)}`)
      const text = block.content.find(item => item.type === 'text'); assert.ok(text && text.type === 'text'); const path = text.text.match(/situation\/situations\/[a-f0-9-]+\.json/); assert.ok(path)
      yield call('read', 'read', { file_path: path[0] })
    } else if (this.step === 3) {
      const block = options.messages.flatMap(m => m.content).find(item => item.type === 'tool-result' && item.toolCallId === 'read'); assert.ok(block && block.type === 'tool-result' && !block.isError); assert.match(JSON.stringify(block.content), /已补充影响/)
      yield call('foreign', 'read', { file_path: this.foreign })
    } else {
      const block = options.messages.flatMap(m => m.content).find(item => item.type === 'tool-result' && item.toolCallId === 'foreign'); assert.ok(block && block.type === 'tool-result' && block.isError)
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '已核对局势' } }; yield { type: 'finish', reason: { kind: 'stop' } }; return
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}
test('修仙与城邦世界经主 Agent 委派并核对多个局势方案', { timeout: 30000 }, async t => {
  const tmp = join(process.cwd(), 'tmp'); await mkdir(tmp, { recursive: true }); const root = await realpath(await mkdtemp(join(tmp, 'situation-e2e-'))); t.after(() => rm(root, { recursive: true, force: true }))
  const sessionRoot = join(root, 'sessions'); await mkdir(sessionRoot); const worlds: WorldWorkspaceConfig[] = []
  for (const worldId of ['cultivation', 'city']) {
    const readRoot = join(root, worldId); for (const folder of ['main', 'situation/overviews', 'situation/situations', 'situation/candidates', 'confirmed', 'catalog']) await mkdir(join(readRoot, folder), { recursive: true })
    const world = { worldId, readRoot, confirmedRoot: join(readRoot, 'confirmed'), catalogRoot: join(readRoot, 'catalog'), mainAgent: { agentId: 'main', writableRoot: join(readRoot, 'main') }, agents: [{ agentId: 'situation', writableRoot: join(readRoot, 'situation') }] }
    await writeFile(join(world.confirmedRoot, 'private.md'), worldId); await initializeCatalog(world.catalogRoot, worldId); worlds.push(world)
  }
  for (const [index, world] of worlds.entries()) {
    const child = new Planner(index === 1); const mock = t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'test', adapter: new Parent(join(worlds[1-index]!.confirmedRoot, 'private.md'), child) }))
    const parent = await createWorldInitializationAgentWithWorldWorkspaces(worlds, world.worldId, undefined, { singleWriterProcess: true, catalog: {}, initialSituationAgent: { agentId: 'situation', sessionId: 's', sessionRoot, sessionMode: 'create', provider: 'test', model: 'test', adapter: child } })
    try { assert.deepEqual(await parent.run({ prompt: '规划局势' }), { content: '已核对局势' }) } finally { await parent.dispose(); mock.mock.restore() }
    const directory = join(world.readRoot, 'situation/situations'); const items = await Promise.all((await readdir(directory)).map(async name => parseJson(await readFile(join(directory, name), 'utf8'), situationSchema)))
    assert.equal(items.length, 3); assert.ok(items.every(item => item.worldId === world.worldId && item.contentStatus === 'suggested')); assert.equal(new Set(items.map(item => item.overviewId)).size, 2)
    assert.ok(items.some(item => item.relations.length === 1)); assert.ok(items.every(item => item.reserved.length > 0))
  }
})
