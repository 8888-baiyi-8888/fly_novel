import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import fsPromises = require('node:fs/promises')
import { CharacterStore } from '@fly-novel/character'
import { CharacterRelationshipStore } from '@fly-novel/character'

test('关系存储复用真实角色 ID，保护无序配对、线索和旧角色资料', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'character-relations-'))); t.after(() => rm(root, { recursive: true, force: true }))
  const charactersRoot = join(root, 'characters'); const relationsRoot = join(charactersRoot, 'relationships')
  await mkdir(charactersRoot); const characters = await CharacterStore.open(charactersRoot, true); t.after(() => characters.close())
  const character = { name: '林岚', summary: '', categories: {}, body: '既有资料' }
  const a = await characters.create(character); const b = await characters.create(character); const c = await characters.create({ ...character, name: '顾青' })
  const before = await readFile(join(charactersRoot, a.id, 'profile.md'), 'utf8'); await mkdir(relationsRoot)
  const store = await CharacterRelationshipStore.open({ root: relationsRoot, worldId: 'world-a', phase: 'initialization', singleWriterProcess: true,
    resolvePerson: async id => { try { const person = await characters.read(id); return { id: person.metadata.id, worldId: 'world-a' } } catch { return null } } })
  t.after(() => store.close())
  await assert.rejects(CharacterRelationshipStore.open({ root: relationsRoot, worldId: 'world-a', phase: 'initialization', singleWriterProcess: true, resolvePerson: async () => null }), /使用/)
  const relation = await store.create({ participants: [{ kind: 'linked', id: a.id }, { kind: 'linked', id: b.id }], relations: [
    { name: '师徒', direction: 'a-to-b', description: '已存在' }, { name: '亲属', direction: 'two-way', description: '' }] })
  assert.equal((await store.read(relation.document.id)).document.relations.length, 2)
  await assert.rejects(store.create({ participants: [{ kind: 'linked', id: b.id }, { kind: 'linked', id: a.id }], relations: [] }), /配对/)
  await assert.rejects(store.update(relation.document.id, 'wrong', relation.document), /版本/)
  const clue = await store.create({ participants: [{ kind: 'linked', id: a.id }, { kind: 'unresolved', description: '未建档师父' }], relations: [] })
  const unresolved = clue.document.participants[1]; assert.equal(unresolved.kind, 'unresolved')
  if (unresolved.kind !== 'unresolved') throw new Error('线索类型错误')
  const to = (id: string) => ({ ...clue.document, participants: [clue.document.participants[0], { kind: 'linked' as const, id, previousClue: { clueId: unresolved.clueId, description: unresolved.description } }] as typeof clue.document.participants })
  await assert.rejects(store.update(clue.document.id, clue.version, to(b.id)), /配对/)
  const linked = await store.update(clue.document.id, clue.version, to(c.id))
  assert.equal(linked.document.id, clue.document.id)
  assert.equal(linked.document.participants[1].kind, 'linked')
  await assert.rejects(store.create({ participants: [{ kind: 'linked', id: a.id }, { kind: 'linked', id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }], relations: [] }), /不存在/)
  assert.equal(await readFile(join(charactersRoot, a.id, 'profile.md'), 'utf8'), before)
  assert.equal((await characters.query({ name: '林岚' })).length, 2)
})

test('未知版本和跨世界数据拒绝读取并保留原文件', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'character-relations-invalid-'))); t.after(() => rm(root, { recursive: true, force: true }))
  const store = await CharacterRelationshipStore.open({ root, worldId: 'world-a', phase: 'initialization', singleWriterProcess: true, resolvePerson: async id => ({ id, worldId: 'other' }) }); t.after(() => store.close())
  const id = '5ac5fb8d-8827-4b52-bbd6-07e4878c5513'; const raw = '{"formatVersion":2}'
  await writeFile(join(root, `${id}.json`), raw)
  await assert.rejects(store.read(id)); assert.equal(await readFile(join(root, `${id}.json`), 'utf8'), raw)
  await rm(join(root, `${id}.json`))
  await assert.rejects(store.create({ participants: [{ kind: 'linked', id: '2e59b48c-2c7c-4abc-b232-97dc06111001' }, { kind: 'unresolved', description: '未知' }], relations: [] }), /世界不匹配/)
})

test('已确认关系不能直接覆盖，取消后保持原文件', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'character-relations-confirmed-'))); t.after(() => rm(root, { recursive: true, force: true }))
  const store = await CharacterRelationshipStore.open({ root, worldId: 'world-a', phase: 'initialization', singleWriterProcess: true, resolvePerson: async id => ({ id, worldId: 'world-a' }) }); t.after(() => store.close())
  const entry = await store.create({ participants: [{ kind: 'linked', id: '2e59b48c-2c7c-4abc-b232-97dc06111001' }, { kind: 'unresolved', description: '未知师父' }], relations: [] })
  const aborted = new AbortController(); aborted.abort()
  await assert.rejects(store.update(entry.document.id, entry.version, entry.document, aborted.signal))
  const path = join(root, entry.path); const original = await readFile(path, 'utf8'); assert.match(original, /suggested/)
  await writeFile(path, original.replace('"suggested"', '"confirmed"'))
  const confirmed = await store.read(entry.document.id)
  await assert.rejects(store.update(entry.document.id, confirmed.version, confirmed.document), /已确认/)
  assert.equal(await readFile(path, 'utf8'), original.replace('"suggested"', '"confirmed"'))
})

test('并发创建同一配对只保存一份，关闭等待已受理操作', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'character-relations-concurrent-'))); t.after(() => rm(root, { recursive: true, force: true }))
  let release!: () => void; let entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }); const started = new Promise<void>(resolve => { entered = resolve })
  let calls = 0
  const store = await CharacterRelationshipStore.open({ root, worldId: 'world-a', phase: 'initialization', singleWriterProcess: true, resolvePerson: async id => {
    if (++calls === 1) { entered(); await gate }
    return { id, worldId: 'world-a' }
  } })
  const input = { participants: [{ kind: 'linked' as const, id: '2e59b48c-2c7c-4abc-b232-97dc06111001' }, { kind: 'linked' as const, id: 'a903f138-ccaf-4ef4-b89f-04d89c3c1ab2' }] as [{ kind: 'linked'; id: string }, { kind: 'linked'; id: string }], relations: [] }
  const first = store.create(input); await started
  const second = store.create(input); const failed = assert.rejects(second, /配对/)
  const closing = store.close(); await assert.rejects(store.create(input), /关闭/)
  release(); await first; await failed; await closing
  assert.equal((await readdir(root)).filter(name => name.endsWith('.json')).length, 1)
})

test('关系发布结果不确定时返回目标并保留实际成果', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'character-relations-unknown-'))); t.after(() => rm(root, { recursive: true, force: true }))
  const store = await CharacterRelationshipStore.open({ root, worldId: 'world-a', phase: 'initialization', singleWriterProcess: true, resolvePerson: async id => ({ id, worldId: 'world-a' }) }); t.after(() => store.close())
  const initial = await store.create({ participants: [{ kind: 'linked', id: '2e59b48c-2c7c-4abc-b232-97dc06111001' }, { kind: 'unresolved', description: '旧线索' }], relations: [] })
  const renameFile = fsPromises.rename
  const mock = t.mock.method(fsPromises, 'rename', async (from: Parameters<typeof renameFile>[0], to: Parameters<typeof renameFile>[1]) => { await renameFile(from, to); throw new Error('模拟发布后结果丢失') })
  const [a, b] = initial.document.participants; assert.equal(b.kind, 'unresolved')
  if (b.kind !== 'unresolved') throw new Error('线索类型错误')
  await assert.rejects(store.update(initial.document.id, initial.version, { ...initial.document, participants: [a, { ...b, description: '新线索' }] }),
    { code: 'CHARACTER_RELATIONSHIP_COMMIT_UNKNOWN', path: initial.path })
  mock.mock.restore()
  const actual = await store.read(initial.document.id); assert.equal(actual.document.participants[1].kind, 'unresolved')
  if (actual.document.participants[1].kind === 'unresolved') assert.equal(actual.document.participants[1].description, '新线索')
})
