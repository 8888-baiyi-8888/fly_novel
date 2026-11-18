import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { CharacterStore, parseCharacterRelationship } from '@fly-novel/character'
import { LlmAdapter, type GenerateOptions, type StreamChunk, type ToolCallId } from '@fly-novel/llm'
import { initializeCatalog } from '../../world-init/workspace/catalog/format.js'
import type { WorldWorkspaceConfig } from '../../world-init/workspace/config.js'
import { createWorldInitializationAgentWithWorldWorkspaces } from '../agents/index.js'
import configured = require('../call-llm.js')

function call(index: number, id: string, name: string, args: object): StreamChunk {
  return { type: 'block-end', index, block: { type: 'tool-call', id: id as ToolCallId, name, arguments: JSON.stringify(args) } }
}
function result(options: GenerateOptions, id: string): Record<string, unknown> {
  const block = options.messages.flatMap(message => message.content).find(item => item.type === 'tool-result' && item.toolCallId === id)
  assert.ok(block && block.type === 'tool-result' && !block.isError, `${id}: ${JSON.stringify(block)}`)
  const text = block.content.find(item => item.type === 'text'); assert.ok(text && text.type === 'text')
  const parsed: unknown = JSON.parse(text.text); assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed))
  return Object.fromEntries(Object.entries(parsed))
}

class CharacterAdapter extends LlmAdapter {
  private step = 0
  failure: unknown
  constructor(private readonly city: boolean) { super() }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    try { yield* this.execute(options) } catch (error) { this.failure = error; throw error }
  }
  private async *execute(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const a = this.city ? '曲水使者' : '林岚'; const b = this.city ? '河谷使者' : '顾青'
    const character = (name: string, body: string) => ({ name, summary: this.city ? '城邦代表' : '修行者', categories: {}, body })
    switch (++this.step) {
      case 1:
        yield call(0, 'a', 'character_create', { character: character(a, '初始目标') })
        yield call(1, 'b', 'character_create', { character: character(b, '初始处境') }); break
      case 2:
        yield call(0, 'relation', 'character_relationship_create', { relationship: { participants: [{ kind: 'linked', id: result(options, 'a').id }, { kind: 'linked', id: result(options, 'b').id }],
          relations: [{ name: this.city ? '取水协商' : '师徒', direction: 'a-to-b', description: '初始化时已有关系' }, { name: '信任', direction: 'b-to-a', description: '单向信任' }] } })
        yield call(1, 'catalog', 'catalog_register', { path: `characters/${result(options, 'a').id}/profile.md`, summary: a }); break
      case 3:
        result(options, 'relation'); result(options, 'catalog')
        yield call(0, 'from-a', 'character_relationship_search', { personId: result(options, 'a').id })
        yield call(1, 'from-b', 'character_relationship_search', { personId: result(options, 'b').id })
        yield call(2, 'read', 'character_initialization_read', { id: result(options, 'a').id }); break
      case 4:
        assert.equal(result(options, 'from-a').total, 1); assert.equal(result(options, 'from-b').total, 1)
        yield call(0, 'update', 'character_initialization_update', { id: result(options, 'a').id, version: result(options, 'read').version, character: character(a, '更新后的目标') }); break
      case 5:
        result(options, 'update')
        yield call(0, 'stale', 'catalog_read', { path: `characters/${result(options, 'a').id}/profile.md` }); break
      default:
        assert.equal(result(options, 'stale').fileStatus, 'stale')
        yield { type: 'block-end', index: 0, block: { type: 'text', text: `人物关系文件：characters/relationships/${(result(options, 'relation').document as { id: string }).id}.json` } }
        yield { type: 'finish', reason: { kind: 'stop' } }; return
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

class ParentAdapter extends LlmAdapter {
  private step = 0
  constructor(private readonly foreign: string, private readonly child: CharacterAdapter) { super() }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    switch (++this.step) {
      case 1: yield call(0, 'delegate', 'delegate_character_creator', { task: '依据世界构想创建当时已有的人物关系并登记成果' }); break
      case 2: {
        const block = options.messages.flatMap(message => message.content).find(item => item.type === 'tool-result' && item.toolCallId === 'delegate')
        assert.ok(block && block.type === 'tool-result' && !block.isError, `${JSON.stringify(block)}; child: ${String(this.child.failure)}`)
        const content = block.content.find(item => item.type === 'text'); assert.ok(content && content.type === 'text')
        const path = content.text.match(/characters\/relationships\/[a-f0-9-]+\.json/)?.[0]; assert.ok(path)
        yield call(0, 'read-result', 'read', { file_path: path }); break
      }
      case 3: {
        const block = options.messages.flatMap(message => message.content).find(item => item.type === 'tool-result' && item.toolCallId === 'read-result')
        assert.ok(block && block.type === 'tool-result' && !block.isError); assert.match(JSON.stringify(block.content), /师徒|取水协商/)
        yield call(0, 'foreign', 'read', { file_path: this.foreign }); break
      }
      default: {
        const block = options.messages.flatMap(message => message.content).find(item => item.type === 'tool-result' && item.toolCallId === 'foreign')
        assert.ok(block && block.type === 'tool-result' && block.isError)
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '已核对人物关系' } }; yield { type: 'finish', reason: { kind: 'stop' } }; return
      }
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

test('修仙与城邦世界从主 Agent 委派到人物关系文件、双向查询及目录核对', { timeout: 30000 }, async t => {
  const tmp = join(process.cwd(), 'tmp'); await mkdir(tmp, { recursive: true })
  const root = await realpath(await mkdtemp(join(tmp, 'character-e2e-'))); t.after(() => rm(root, { recursive: true, force: true }))
  const sessionRoot = join(root, 'sessions'); await mkdir(sessionRoot)
  const worlds: WorldWorkspaceConfig[] = []
  for (const id of ['cultivation', 'city']) {
    const readRoot = join(root, id)
    for (const dir of ['main', 'characters', 'confirmed', 'catalog']) await mkdir(join(readRoot, dir), { recursive: true })
    const world = { worldId: id, readRoot, confirmedRoot: join(readRoot, 'confirmed'), catalogRoot: join(readRoot, 'catalog'),
      mainAgent: { agentId: 'main', writableRoot: join(readRoot, 'main') }, agents: [{ agentId: 'characters', writableRoot: join(readRoot, 'characters') }] }
    await writeFile(join(world.confirmedRoot, 'private.md'), id); await initializeCatalog(world.catalogRoot, id); worlds.push(world)
  }
  for (const [index, world] of worlds.entries()) {
    const characterRoot = join(world.readRoot, 'characters')
    const existing = await CharacterStore.open(characterRoot, true)
    const old = await existing.create({ name: '旧人物', summary: '', categories: {}, body: '旧资料' })
    await existing.prepare(old.id, { name: '旧人物', summary: '', categories: {}, body: '待审内容' }); await existing.close()
    const original = await readFile(join(characterRoot, old.id, 'profile.md'), 'utf8')
    const child = new CharacterAdapter(index === 1)
    const mock = t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'test', adapter: new ParentAdapter(join(worlds[1-index]!.confirmedRoot, 'private.md'), child) }))
    const parent = await createWorldInitializationAgentWithWorldWorkspaces(worlds, world.worldId, { agentId: 'characters', sessionId: 'session', sessionMode: 'create', sessionRoot,
      provider: 'test', model: 'test', adapter: child, defaultCharacterCount: 2, initializeCharacters: false }, { singleWriterProcess: true, catalog: {} })
    try { assert.deepEqual(await parent.run({ prompt: index ? '规划资源有限的城邦人物' : '规划开放修仙世界人物' }), { content: '已核对人物关系' }) }
    finally { await parent.dispose(); mock.mock.restore() }
    const relations = (await Promise.all((await readdir(join(characterRoot, 'relationships'))).filter(name => name.endsWith('.json')).map(name => readFile(join(characterRoot, 'relationships', name), 'utf8')))).map(parseCharacterRelationship)
    assert.equal(relations.length, 1); assert.equal(relations[0]!.worldId, world.worldId); assert.equal(relations[0]!.relations.length, 2)
    assert.equal(await readFile(join(characterRoot, old.id, 'profile.md'), 'utf8'), original)
    const reopened = await CharacterStore.open(characterRoot); try { assert.match((await reopened.readPending(old.id)).document.body, /待审内容/) } finally { await reopened.close() }
    assert.match(await readFile(join(world.catalogRoot, 'catalog.json'), 'utf8'), index ? /曲水使者/ : /林岚/)
  }
})
