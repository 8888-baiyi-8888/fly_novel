import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { CharacterStore } from '../character-store.js'
import { formatCharacterDocument } from '../character-format.js'

const character = { name: '林岚', summary: '长老', categories: { faction: [{ id: 'a', name: '宗门' }] }, body: '原始资料' }
const hash = (text: string) => createHash('sha256').update(text).digest('hex')

test('同名角色独立创建，分类查询及待审修改保留原资料', async t => {
  const root = await mkdtemp(join(tmpdir(), 'character-store-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = await CharacterStore.open(root, true)
  t.after(() => store.close())
  const first = await store.create(character)
  const second = await store.create({ ...character, summary: '弟子' })
  assert.notEqual(first.id, second.id)
  assert.equal((await store.query({ name: '林岚' })).length, 2)
  assert.equal((await store.query({ categories: { faction: ['a'] } })).length, 2)
  assert.equal((await store.query({ categories: { faction: ['a'], importance: ['tier-2'] } })).length, 0)
  const candidate = await store.prepare(first.id, { ...character, name: '林舟', body: '修改建议' })
  assert.deepEqual({ baseline: (await store.readPending(first.id)).baseline, candidate: (await store.readPending(first.id)).candidate }, candidate)
  assert.equal((await store.read(first.id)).body, '原始资料\n')
  assert.equal((await store.query({ name: '林岚' })).length, 2)
  await assert.rejects(store.commit(first.id, { ...candidate, baseline: '0'.repeat(64) }), /基线不匹配/)
  await store.commit(first.id, candidate)
  assert.equal((await store.read(first.id)).metadata.contentStatus, 'confirmed')
  assert.equal((await store.query({ name: '林岚' })).length, 1)
  assert.equal((await store.query({ name: '林舟' })).length, 1)
  const results = await store.readMany([first.id, '2e59b48c-2c7c-4abc-b232-97dc06111001'])
  assert.ok('document' in results[0]!)
  assert.ok('error' in results[1]!)
})

test('索引损坏不伪装成无结果，可从完整资料重建', async t => {
  const root = await mkdtemp(join(tmpdir(), 'character-index-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = await CharacterStore.open(root, true)
  t.after(() => store.close())
  const item = await store.create(character)
  await writeFile(join(root, 'index.json'), '{broken')
  await assert.rejects(store.query({ name: item.name }))
  await store.rebuildIndex()
  assert.equal((await store.query({ name: item.name }))[0]?.id, item.id)
  await writeFile(join(root, 'index.json'), JSON.stringify({ formatVersion: 2, characters: [] }))
  await assert.rejects(store.rebuildIndex(), /未知版本/)
  assert.match(await readFile(join(root, 'index.json'), 'utf8'), /"formatVersion":2/)
})

test('需求清单更新必须匹配读取版本', async t => {
  const root = await mkdtemp(join(tmpdir(), 'character-requirements-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = await CharacterStore.open(root, true)
  t.after(() => store.close())
  const data = { formatVersion: 1 as const, requirements: [] }
  const version = await store.saveRequirements(data, '近期需求')
  assert.equal((await store.readRequirements()).version, version)
  await assert.rejects(store.saveRequirements(data, '错误更新', '0'.repeat(64)), /已变化/)
  await store.saveRequirements(data, '更新后的需求', version)
  assert.equal((await store.readRequirements()).body, '更新后的需求\n')
})

test('写入中断后以实际摘要恢复，不覆盖原资料', async t => {
  const root = await mkdtemp(join(tmpdir(), 'character-recover-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = await CharacterStore.open(root, true)
  const item = await store.create(character)
  await store.prepare(item.id, { ...character, body: '待审资料' })
  const profile = await readFile(join(root, item.id, 'profile.md'), 'utf8')
  await writeFile(join(root, item.id, 'operation.json'), JSON.stringify({ formatVersion: 1, id: item.id, baseline: hash(profile), candidate: '0'.repeat(64), phase: 'prepared' }))
  await store.close()
  await assert.rejects(CharacterStore.open(root), /未完成/)
  const recovery = await CharacterStore.open(root, false, true)
  t.after(() => recovery.close())
  assert.equal(await recovery.recover(item.id), 'retry')
  assert.equal((await recovery.read(item.id)).body, '原始资料\n')
})

test('资料已更新但索引未更新时，可依据备份和摘要重建索引', async t => {
  const root = await mkdtemp(join(tmpdir(), 'character-recover-index-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = await CharacterStore.open(root, true)
  const item = await store.create(character)
  await store.prepare(item.id, { ...character, name: '林舟', body: '修改建议' })
  const pending = await store.readPending(item.id)
  const dir = join(root, item.id)
  const original = await readFile(join(dir, 'profile.md'), 'utf8')
  const updated = formatCharacterDocument({ ...pending.document, metadata: { ...pending.document.metadata, contentStatus: 'confirmed' } })
  await writeFile(join(dir, 'operation.json'), JSON.stringify({ formatVersion: 1, id: item.id,
    baseline: hash(original), candidate: hash(updated), phase: 'profile-written' }))
  await writeFile(join(dir, 'backup.md'), original)
  await writeFile(join(dir, 'profile.md'), updated)
  await store.close()
  const recovery = await CharacterStore.open(root, false, true)
  t.after(() => recovery.close())
  assert.equal(await recovery.recover(item.id), 'completed')
  assert.equal((await recovery.query({ name: '林舟' }))[0]?.id, item.id)
})
