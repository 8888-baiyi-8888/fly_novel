import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseHistoryEvent } from '@fly-novel/history'
import { LlmAdapter, type GenerateOptions, type StreamChunk, type ToolCallId } from '@fly-novel/llm'
import { initializeCatalog } from '../../world-init/workspace/catalog/format.js'
import type { WorldWorkspaceConfig } from '../../world-init/workspace/config.js'
import configured = require('../call-llm.js')
import { createWorldInitializationAgentWithWorldWorkspaces } from '../agents/index.js'

function call(id: string, name: string, args: object): StreamChunk {
  return { type: 'block-end', index: 0, block: { type: 'tool-call', id: id as ToolCallId, name, arguments: JSON.stringify(args) } }
}
function result(options: GenerateOptions, id: string): Record<string, unknown> {
  const block = options.messages.flatMap(message => message.content).find(item => item.type === 'tool-result' && item.toolCallId === id)
  assert.ok(block && block.type === 'tool-result' && !block.isError, `${id}: ${JSON.stringify(block)}`)
  const item = block.content.find(value => value.type === 'text'); assert.ok(item && item.type === 'text')
  const parsed: unknown = JSON.parse(item.text); assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed))
  return Object.fromEntries(Object.entries(parsed))
}
class Historian extends LlmAdapter {
  private step = 0
  failure: unknown
  constructor(private readonly city: boolean) { super() }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    try { yield* this.execute(options) } catch (error) { this.failure = error; throw error }
  }
  private async *execute(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.step++
    const name = this.city ? '青河战争' : '青云迁徙'
    const content = { name, aliases: [], detailLevel: 'overview', summary: '往事概况', body: '', time: [{ kind: 'text', original: '年代未知' }], parents: [], childrenCoverage: 'partial', relations: [], references: [{ kind: 'unresolved', type: 'person', description: '未建档参与者' }], publicAccounts: [{ content: '公开说法', source: '传闻' }], hidden: { state: 'unknown', note: '原因未明' }, reserved: ['远方历史留白'] }
    if (this.step === 1) { yield call('first', 'history_event_create', { content }); yield call('second', 'history_event_create', { content: { ...content, name: this.city ? '水渠冲突' : '灵脉变动' } }) }
    else if (this.step === 2) {
      yield call('child', 'history_event_create', { content: { ...content, name: this.city ? '停战谈判' : '山门迁建', parents: [{ id: result(options, 'first').id, description: '组成部分' }, { id: result(options, 'second').id, description: '相关阶段' }] } })
      yield call('catalog', 'catalog_register', { path: `history/${result(options, 'first').path}`, summary: name })
    } else if (this.step === 3) {
      result(options, 'child'); result(options, 'catalog')
      yield call('children', 'history_event_children', { id: result(options, 'first').id })
      yield call('ancestors', 'history_event_ancestors', { id: result(options, 'child').id })
      yield call('timeline', 'history_timeline', {})
    } else if (this.step === 4) {
      assert.match(JSON.stringify(result(options, 'children')), this.city ? /停战谈判/ : /山门迁建/)
      assert.match(JSON.stringify(result(options, 'ancestors')), this.city ? /水渠冲突/ : /灵脉变动/)
      assert.equal(result(options, 'timeline').complete, false)
      yield call('update', 'history_event_update', { id: result(options, 'first').id, version: result(options, 'first').version, content: { ...content, summary: '补充的往事概况' } })
    } else if (this.step === 5) {
      result(options, 'update'); yield call('stale', 'catalog_read', { path: `history/${result(options, 'first').path}` })
    } else {
      assert.equal(result(options, 'stale').fileStatus, 'stale')
      yield { type: 'block-end', index: 0, block: { type: 'text', text: `历史成果：history/${result(options, 'first').path}` } }; yield { type: 'finish', reason: { kind: 'stop' } }; return
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}
class Parent extends LlmAdapter {
  private step = 0
  constructor(private readonly foreign: string, private readonly child: Historian) { super() }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.step++
    if (this.step === 1) yield call('delegate', 'delegate_history', { task: '建立近期历史并保留未知内容' })
    else if (this.step === 2) {
      const block = options.messages.flatMap(message => message.content).find(item => item.type === 'tool-result' && item.toolCallId === 'delegate')
      assert.ok(block && block.type === 'tool-result' && !block.isError, `${JSON.stringify(block)}; 子 Agent: ${String(this.child.failure)}`)
      const text = block.content.find(item => item.type === 'text'); assert.ok(text && text.type === 'text')
      const path = text.text.match(/history\/events\/[a-f0-9-]+\.json/); assert.ok(path)
      yield call('read', 'read', { file_path: path[0] })
    } else if (this.step === 3) {
      const block = options.messages.flatMap(message => message.content).find(item => item.type === 'tool-result' && item.toolCallId === 'read')
      assert.ok(block && block.type === 'tool-result' && !block.isError); assert.match(JSON.stringify(block.content), /补充的往事概况/)
      yield call('foreign', 'read', { file_path: this.foreign })
    } else {
      const block = options.messages.flatMap(message => message.content).find(item => item.type === 'tool-result' && item.toolCallId === 'foreign')
      assert.ok(block && block.type === 'tool-result' && block.isError)
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '已核对历史成果' } }; yield { type: 'finish', reason: { kind: 'stop' } }; return
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}
test('修仙与城邦世界通过主 Agent 委派并核对历史事件', { timeout: 30000 }, async t => {
  const tmp = join(process.cwd(), 'tmp'); await mkdir(tmp, { recursive: true })
  const root = await realpath(await mkdtemp(join(tmp, 'history-e2e-'))); t.after(() => rm(root, { recursive: true, force: true }))
  const sessionRoot = join(root, 'sessions'); await mkdir(sessionRoot)
  const worlds: WorldWorkspaceConfig[] = []
  for (const id of ['cultivation', 'city']) {
    const readRoot = join(root, id)
    for (const dir of ['main', 'history/events', 'history/candidates', 'confirmed', 'catalog']) await mkdir(join(readRoot, dir), { recursive: true })
    const world = { worldId: id, readRoot, confirmedRoot: join(readRoot, 'confirmed'), catalogRoot: join(readRoot, 'catalog'), mainAgent: { agentId: 'main', writableRoot: join(readRoot, 'main') }, agents: [{ agentId: 'history', writableRoot: join(readRoot, 'history') }] }
    await writeFile(join(world.confirmedRoot, 'private.md'), id); await initializeCatalog(world.catalogRoot, id); worlds.push(world)
  }
  for (const [index, world] of worlds.entries()) {
    const child = new Historian(index === 1)
    const mock = t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'test', adapter: new Parent(join(worlds[1-index]!.confirmedRoot, 'private.md'), child) }))
    const parent = await createWorldInitializationAgentWithWorldWorkspaces(worlds, world.worldId, undefined, { singleWriterProcess: true, catalog: {}, historyAgent: { agentId: 'history', sessionId: 's', sessionMode: 'create', sessionRoot, provider: 'test', model: 'test', adapter: child } })
    try { assert.deepEqual(await parent.run({ prompt: '规划历史' }), { content: '已核对历史成果' }) } finally { await parent.dispose(); mock.mock.restore() }
    const directory = join(world.readRoot, 'history/events')
    const events = await Promise.all((await readdir(directory)).map(async name => parseHistoryEvent(await readFile(join(directory, name), 'utf8'))))
    assert.equal(events.length, 3); assert.ok(events.every(item => item.worldId === world.worldId && item.contentStatus === 'suggested' && item.hidden.state === 'unknown'))
    assert.equal(events.find(item => item.parents.length)?.parents.length, 2)
  }
})
