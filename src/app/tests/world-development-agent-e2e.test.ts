import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@fly-novel/fs-local'
import { SituationStore } from '@fly-novel/initial-situation'
import { CharacterStore } from '@fly-novel/character'
import { parseDocumentJson, documentSchema } from '@fly-novel/world-development'
import { LlmAdapter, type GenerateOptions, type StreamChunk, type ToolCallId } from '@fly-novel/llm'
import { initializeCatalog } from '../../world-init/workspace/catalog/format.js'
import type { WorldWorkspaceConfig } from '../../world-init/workspace/config.js'
import configured = require('../call-llm.js')
import { createWorldInitializationAgentWithWorldWorkspaces } from '../agents/index.js'

const dirs = ['macro-development/blueprints', 'macro-development/directions', 'macro-development/proposals', 'storylines/stories', 'storylines/growth-lines', 'character-growth/blueprints', 'character-growth/items', 'candidates']
function call(id: string, name: string, args: object): StreamChunk { return { type: 'block-end', index: 0, block: { type: 'tool-call', id: id as ToolCallId, name, arguments: JSON.stringify(args) } } }
function result(options: GenerateOptions, id: string): Record<string, unknown> {
  const block = options.messages.flatMap(message => message.content).find(item => item.type === 'tool-result' && item.toolCallId === id)
  assert.ok(block && block.type === 'tool-result' && !block.isError, `${id}: ${JSON.stringify(block)}`)
  const text = block.content.find(item => item.type === 'text'); assert.ok(text && text.type === 'text'); const parsed: unknown = JSON.parse(text.text)
  assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed)); return Object.fromEntries(Object.entries(parsed))
}
class Planner extends LlmAdapter {
  private step = 0; failure: unknown
  constructor(private readonly city: boolean, private readonly a: string, private readonly b: string, private readonly person: string) { super() }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> { try { yield* this.execute(options) } catch (error) { this.failure = error; throw error } }
  private async *execute(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.step++
    const content = (name: string) => ({ name, summary: '', body: '', reserved: ['未来未知'], applicability: { kind: 'unknown' }, references: [], links: [], person: null })
    const link = (targetKind: string, targetId: unknown) => ({ targetKind, targetId, relation: '相关', description: '规划关联' })
    if (this.step === 1) {
      yield call('macro', 'world_development_create', { kind: 'macro-blueprint', content: content('世界蓝图') })
      yield call('event', 'world_development_create', { kind: 'proposal', content: content(this.city ? '可能谈判' : '可能探索') })
      yield call('growth', 'world_development_create', { kind: 'growth-line', content: { ...content('角色成长'), person: { kind: 'linked', id: this.person } } })
      yield call('blueprint', 'world_development_create', { kind: 'growth-blueprint', content: content('人物成长蓝图') })
    } else if (this.step === 2) {
      result(options, 'macro'); result(options, 'blueprint')
      yield call('direction', 'world_development_create', { kind: 'direction', content: { ...content('协作'), applicability: { kind: 'scoped', scopes: [{ overviewId: this.a, description: '方案甲条件', situationIds: [] }, { overviewId: this.b, description: '方案乙条件', situationIds: [] }] }, links: [link('proposal', result(options, 'event').id)] } })
      yield call('story', 'world_development_create', { kind: 'storyline', content: { ...content(this.city ? '水源争议' : '灵脉探索'), links: [link('proposal', result(options, 'event').id)] } })
      yield call('item', 'world_development_create', { kind: 'growth-item', content: { ...content('人物呼应'), links: [link('growth-line', result(options, 'growth').id)] } })
      yield call('catalog', 'catalog_register', { path: `development/${result(options, 'event').path}`, summary: '事件构想' })
    } else if (this.step === 3) {
      for (const id of ['direction', 'story', 'item', 'catalog']) result(options, id)
      yield call('a', 'world_development_search', { overviewId: this.a, kind: 'direction' })
      yield call('b', 'world_development_search', { overviewId: this.b, kind: 'direction' })
      yield call('people', 'world_development_search', { personId: this.person })
      yield call('related', 'world_development_related_read', { kind: 'proposal', id: result(options, 'event').id })
    } else if (this.step === 4) {
      assert.equal(result(options, 'a').total, 1); assert.equal(result(options, 'b').total, 1); assert.match(JSON.stringify(result(options, 'people')), /人物呼应/); assert.equal((result(options, 'related').items as unknown[]).length, 2)
      yield call('update', 'world_development_update', { kind: 'proposal', id: result(options, 'event').id, version: result(options, 'event').version, content: { ...content(this.city ? '可能谈判' : '可能探索'), summary: '影响待讨论' } })
    } else if (this.step === 5) { result(options, 'update'); yield call('stale', 'catalog_read', { path: `development/${result(options, 'event').path}` }) }
    else {
      assert.equal(result(options, 'stale').fileStatus, 'stale'); yield { type: 'block-end', index: 0, block: { type: 'text', text: `规划成果：development/${result(options, 'event').path}` } }; yield { type: 'finish', reason: { kind: 'stop' } }; return
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}
class Parent extends LlmAdapter {
  private step = 0
  constructor(private readonly foreign: string, private readonly child: Planner) { super() }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.step++
    if (this.step === 1) yield call('delegate', 'delegate_world_development', { task: '联合规划世界发展、故事线和成长蓝图' })
    else if (this.step === 2) {
      const block = options.messages.flatMap(message => message.content).find(item => item.type === 'tool-result' && item.toolCallId === 'delegate'); assert.ok(block && block.type === 'tool-result' && !block.isError, `${JSON.stringify(block)}; 子任务：${String(this.child.failure)}`)
      const text = block.content.find(item => item.type === 'text'); assert.ok(text && text.type === 'text'); const path = text.text.match(/development\/macro-development\/proposals\/[a-f0-9-]+\.json/); assert.ok(path); yield call('read', 'read', { file_path: path[0] })
    } else if (this.step === 3) {
      const block = options.messages.flatMap(message => message.content).find(item => item.type === 'tool-result' && item.toolCallId === 'read'); assert.ok(block && block.type === 'tool-result' && !block.isError); assert.match(JSON.stringify(block.content), /影响待讨论/); yield call('foreign', 'read', { file_path: this.foreign })
    } else {
      const block = options.messages.flatMap(message => message.content).find(item => item.type === 'tool-result' && item.toolCallId === 'foreign'); assert.ok(block && block.type === 'tool-result' && block.isError)
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '已核对世界规划' } }; yield { type: 'finish', reason: { kind: 'stop' } }; return
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}
test('修仙与城邦世界通过主 Agent 委派并核对三类规划', { timeout: 30000 }, async t => {
  const tmp = join(process.cwd(), 'tmp'); await mkdir(tmp, { recursive: true }); const root = await realpath(await mkdtemp(join(tmp, 'development-e2e-'))); t.after(() => rm(root, { recursive: true, force: true }))
  const sessionRoot = join(root, 'sessions'); await mkdir(sessionRoot); const worlds: WorldWorkspaceConfig[] = []
  for (const worldId of ['cultivation', 'city']) {
    const readRoot = join(root, worldId); for (const folder of ['main', 'confirmed', 'catalog', 'characters', 'situation/overviews', 'situation/situations', 'situation/candidates', ...dirs.map(dir => `development/${dir}`)]) await mkdir(join(readRoot, folder), { recursive: true })
    const world = { worldId, readRoot, confirmedRoot: join(readRoot, 'confirmed'), catalogRoot: join(readRoot, 'catalog'), mainAgent: { agentId: 'main', writableRoot: join(readRoot, 'main') }, agents: ['characters', 'situation', 'development'].map(agentId => ({ agentId, writableRoot: join(readRoot, agentId) })) }
    await writeFile(join(world.confirmedRoot, 'private.md'), worldId); await initializeCatalog(world.catalogRoot, worldId); worlds.push(world)
  }
  for (const [index, world] of worlds.entries()) {
    const ctx = new Context(); const fs = await ctx.plugin(LocalFileSystem, { cwd: world.readRoot }); const situation = await SituationStore.open({ fs: ctx.fs, root: join(world.readRoot, 'situation'), worldId: world.worldId, phase: 'initialization', access: 'read-write', singleWriterProcess: true })
    const chars = await CharacterStore.open(join(world.readRoot, 'characters'), true)
    try {
      await situation.createStart('世界起点'); const a = await situation.createOverview({ name: '甲', summary: '', coverage: '', reserved: [] }); const b = await situation.createOverview({ name: '乙', summary: '', coverage: '', reserved: [] })
      const person = await chars.create({ name: '林岚', summary: '', categories: {}, body: '当前认知' }); const child = new Planner(index === 1, a.id, b.id, person.id)
      const mock = t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'test', adapter: new Parent(join(worlds[1-index]!.confirmedRoot, 'private.md'), child) }))
      const parent = await createWorldInitializationAgentWithWorldWorkspaces(worlds, world.worldId, undefined, { singleWriterProcess: true, catalog: {}, worldDevelopmentAgent: { agentId: 'development', sessionId: 's', sessionRoot, sessionMode: 'create', provider: 'test', model: 'test', adapter: child, references: { situation: { agentId: 'situation', store: situation }, characters: { agentId: 'characters', store: chars } } } })
      try { assert.deepEqual(await parent.run({ prompt: '联合规划' }), { content: '已核对世界规划' }) } finally { await parent.dispose(); mock.mock.restore() }
      const load = async (dir: string) => Promise.all((await readdir(join(world.readRoot, 'development', dir))).map(async name => parseDocumentJson(await readFile(join(world.readRoot, 'development', dir, name), 'utf8'), documentSchema)))
      const growth = await load('storylines/growth-lines'); const items = await load('character-growth/items'); const stories = await load('storylines/stories'); const directions = await load('macro-development/directions')
      assert.equal(growth.length, 1); assert.ok(growth[0]?.person?.kind === 'linked' && growth[0].person.id === person.id); assert.equal(items[0]?.links[0]?.targetId, growth[0]?.id)
      assert.equal(stories.length, 1); assert.ok(directions[0]?.applicability.kind === 'scoped' && directions[0].applicability.scopes.length === 2); assert.ok([growth[0], items[0], stories[0], directions[0]].every(value => value?.contentStatus === 'suggested'))
      assert.match((await chars.read(person.id)).body, /当前认知/)
    } finally { await chars.close(); await situation.close(); await fs.dispose() }
  }
})
