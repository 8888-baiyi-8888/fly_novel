import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import fsPromises = require('node:fs/promises')
import type { ToolCallId } from '@fly-novel/llm'
import { ToolsService } from '@fly-novel/tools'
import { CharacterStore } from '@fly-novel/character'
import { CharacterRelationshipStore } from '@fly-novel/character'
import { createCharacterRelationshipTools } from '@fly-novel/character'

test('人物关系工具按双端和方向查询、显示当前姓名并保护版本与引用', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'character-relation-tools-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const chars = join(root, 'characters'); const relations = join(root, 'relations')
  await mkdir(chars); await mkdir(relations)
  const characters = await CharacterStore.open(chars, true); t.after(() => characters.close())
  const a = await characters.create({ name: '林岚', summary: '', categories: {}, body: '' })
  const b = await characters.create({ name: '顾青', summary: '', categories: {}, body: '' })
  const c = await characters.create({ name: '顾青', summary: '', categories: {}, body: '' })
  const missing = new Set<string>()
  const resolvePerson = async (id: string) => { if (missing.has(id)) return null; const value = await characters.read(id); return { id, worldId: 'world', name: value.metadata.name } }
  const store = await CharacterRelationshipStore.open({ root: relations, worldId: 'world', phase: 'initialization', singleWriterProcess: true, resolvePerson }); t.after(() => store.close())
  assert.throws(() => createCharacterRelationshipTools(store, { worldId: 'other', resolvePerson }), /绑定无效/)
  const tools = new ToolsService(); for (const tool of createCharacterRelationshipTools(store, { worldId: 'world', resolvePerson })) tools.register(tool)
  const call = async (name: string, args: object, signal = new AbortController().signal) => (await tools.execute({ calls: [{ type: 'tool-call', id: 'test' as ToolCallId, name, arguments: JSON.stringify(args) }], signal, workingDirectory: root })).results[0]!.result
  const value = async (name: string, args: object) => { const result = await call(name, args); assert.equal(result.isError, false); if (result.isError || typeof result.value !== 'string') throw new Error('工具失败'); return JSON.parse(result.value) }
  const relation = await value('character_relationship_create', { relationship: { participants: [{ kind: 'linked', id: a.id }, { kind: 'linked', id: b.id }], relations: [
    { name: '师徒', direction: 'a-to-b', description: '师父' }, { name: '信任', direction: 'b-to-a', description: '信任师父' }] } })
  const clue = await value('character_relationship_create', { relationship: { participants: [{ kind: 'linked', id: a.id }, { kind: 'unresolved', description: '未建档师父' }], relations: [] } })
  const fromA = await value('character_relationship_search', { personId: a.id, direction: 'outgoing', keyword: '师徒' })
  const fromB = await value('character_relationship_search', { personId: b.id, direction: 'incoming', keyword: '师徒' })
  assert.equal(fromA.total, 1); assert.equal(fromB.total, 1); assert.equal(fromA.items[0].document.id, relation.document.id)
  assert.equal((await value('character_relationship_search', { personId: b.id, direction: 'outgoing', keyword: '师徒' })).total, 0)
  assert.equal((await value('character_relationship_search', { personId: c.id })).total, 0)
  assert.equal((await value('character_relationship_search', { personId: a.id })).total, 2)
  assert.equal((await value('character_relationship_read', { id: clue.document.id })).people[1].kind, 'unresolved')
  const profile = await characters.readVersioned(b.id)
  await characters.updateInitialization(b.id, profile.version, { name: '顾远', summary: '', categories: {}, body: '' }, 'initialization')
  assert.equal((await value('character_relationship_read', { id: relation.document.id })).people[1].name, '顾远')
  const page = await value('character_relationship_search', { personId: a.id, limit: 1 })
  const updated = await value('character_relationship_update', { id: relation.document.id, version: relation.version, content: { participants: relation.document.participants,
    relations: [...relation.document.relations, { name: '同盟', direction: 'two-way', description: '' }] } })
  assert.equal(updated.document.relations.length, 3); assert.ok(updated.document.relations[2].id)
  assert.equal((await call('character_relationship_search', { personId: a.id, limit: 1, offset: 1, version: page.version })).isError, true)
  assert.equal((await call('character_relationship_update', { id: relation.document.id, version: relation.version, content: relation.document })).isError, true)
  const rename = fsPromises.rename
  const mock = t.mock.method(fsPromises, 'rename', async (from: Parameters<typeof rename>[0], to: Parameters<typeof rename>[1]) => { await rename(from, to); throw new Error('模拟发布后响应丢失') })
  const uncertain = await call('character_relationship_update', { id: relation.document.id, version: updated.version,
    content: { participants: updated.document.participants, relations: updated.document.relations } })
  mock.mock.restore()
  assert.equal(uncertain.isError, true)
  if (!uncertain.isError) throw new Error('应报告发布结果不确定')
  assert.equal(uncertain.error.info.code, 'CHARACTER_RELATIONSHIP_COMMIT_UNKNOWN')
  assert.match(uncertain.error.message, new RegExp(`${relation.document.id}\\.json`))
  assert.equal((await value('character_relationship_read', { id: relation.document.id })).document.relations.length, 3)
  missing.add(b.id)
  assert.equal((await value('character_relationship_read', { id: relation.document.id })).people[1].kind, 'missing')
  assert.equal((await call('character_relationship_search', { personId: b.id })).isError, true)
  const aborted = new AbortController(); aborted.abort()
  assert.equal((await call('character_relationship_read', { id: relation.document.id }, aborted.signal)).isError, true)
})
