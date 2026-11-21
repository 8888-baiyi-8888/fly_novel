import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { CharacterStore } from '@fly-novel/character'
import { formatCharacterDocument } from '@fly-novel/character'
import fsPromises = require('node:fs/promises')

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

test('初始化按摘要更新未确认角色，保留旧数据并拒绝过期与待审冲突', async t => {
  const root = await mkdtemp(join(tmpdir(), 'character-init-')); t.after(() => rm(root, { recursive: true, force: true }))
  const store = await CharacterStore.open(root, true); t.after(() => store.close())
  const item = await store.create(character); const before = await store.readVersioned(item.id)
  const abort = new AbortController(); abort.abort()
  await assert.rejects(store.updateInitialization(item.id, before.version, character, 'initialization', abort.signal))
  assert.equal((await store.readVersioned(item.id)).version, before.version)
  await assert.rejects(store.updateInitialization(item.id, '0'.repeat(64), character, 'initialization'), /变化/)
  const result = await store.updateInitialization(item.id, before.version, { ...character, name: '林舟', body: '初稿调整' }, 'initialization')
  assert.equal((await store.readVersioned(item.id)).version, result.version)
  assert.equal((await store.query({ name: '林舟' }))[0]?.id, item.id)
  await store.prepare(item.id, { ...character, body: '待审候选' })
  await assert.rejects(store.updateInitialization(item.id, result.version, character, 'initialization'), /待审/)
  await assert.rejects(store.publishReviewed(item.id, result.version, character), /待审/)
  assert.equal((await store.readPending(item.id)).document.body, '待审候选\n')
  const candidate = await store.readPending(item.id); await store.commit(item.id, candidate)
  const confirmed = await store.readVersioned(item.id)
  await assert.rejects(store.updateInitialization(item.id, confirmed.version, character, 'initialization'), /已确认/)
  const reviewed = await store.publishReviewed(item.id, confirmed.version, { ...character, name: '林岚', body: '已审阅的修改' })
  await assert.rejects(store.publishReviewed(item.id, confirmed.version, character), /变化/)
  const current = await store.readVersioned(item.id)
  assert.equal(current.version, reviewed.version)
  assert.equal(current.document.metadata.contentStatus, 'confirmed')
  assert.equal((await store.query({ name: '林岚' }))[0]?.id, item.id)
})

test('初始化更新中断后核验摘要恢复，不能覆盖无法识别的文件', async t => {
  const root = await mkdtemp(join(tmpdir(), 'character-init-recovery-')); t.after(() => rm(root, { recursive: true, force: true }))
  const store = await CharacterStore.open(root, true); const item = await store.create(character)
  const dir = join(root, item.id); const original = await readFile(join(dir, 'profile.md'), 'utf8')
  const candidate = formatCharacterDocument({ metadata: { ...item, name: '林舟' }, body: '初始化新资料' })
  const operation = { formatVersion: 1, id: item.id, baseline: hash(original), candidate: hash(candidate), phase: 'prepared' }
  await writeFile(join(dir, 'initialization-operation.json'), JSON.stringify(operation))
  await writeFile(join(dir, 'initialization-backup.md'), original)
  await writeFile(join(dir, 'profile.md'), candidate); await store.close()
  await assert.rejects(CharacterStore.open(root), /未完成/)
  const recovery = await CharacterStore.open(root, false, true); t.after(() => recovery.close())
  const indexPath = join(root, 'index.json'); const oldIndex = await readFile(indexPath, 'utf8')
  await writeFile(indexPath, '{broken')
  await assert.rejects(recovery.recoverInitialization(item.id))
  assert.equal(await readFile(indexPath, 'utf8'), '{broken')
  assert.equal(await readFile(join(dir, 'initialization-backup.md'), 'utf8'), original)
  await writeFile(indexPath, oldIndex)
  assert.equal(await recovery.recoverInitialization(item.id), 'completed')
  assert.equal((await recovery.query({ name: '林舟' }))[0]?.id, item.id)
  await writeFile(join(dir, 'initialization-operation.json'), JSON.stringify(operation))
  await writeFile(join(dir, 'initialization-backup.md'), '不匹配的备份')
  await assert.rejects(recovery.recoverInitialization(item.id), /备份/)
  assert.equal(await readFile(join(dir, 'initialization-backup.md'), 'utf8'), '不匹配的备份')
})

test('初始化资料已写入但索引发布失败时按实际文件恢复', async t => {
  const root = await mkdtemp(join(tmpdir(), 'character-init-fault-')); t.after(() => rm(root, { recursive: true, force: true }))
  const store = await CharacterStore.open(root, true); const item = await store.create(character)
  const before = await store.readVersioned(item.id); const renameFile = fsPromises.rename
  const mock = t.mock.method(fsPromises, 'rename', async (from: Parameters<typeof renameFile>[0], to: Parameters<typeof renameFile>[1]) => {
    if (String(to) === join(root, 'index.json')) throw Object.assign(new Error('模拟索引发布失败'), { code: 'EIO' })
    await renameFile(from, to)
  })
  await assert.rejects(store.updateInitialization(item.id, before.version, { ...character, name: '林舟', body: '新资料' }, 'initialization'), /索引发布失败/)
  mock.mock.restore(); await store.close()
  await assert.rejects(CharacterStore.open(root), /未完成/)
  const recovery = await CharacterStore.open(root, false, true); t.after(() => recovery.close())
  assert.equal(await recovery.recoverInitialization(item.id), 'completed')
  assert.equal((await recovery.read(item.id)).body, '新资料\n')
  assert.equal((await recovery.query({ name: '林舟' }))[0]?.id, item.id)
})

test('初始化更新在资料、索引和清理各阶段失败后可核验恢复', async t => {
  for (const stage of ['profile', 'index', 'operation', 'backup-cleanup', 'operation-cleanup'] as const) {
    const root = await mkdtemp(join(tmpdir(), `character-init-${stage}-`)); t.after(() => rm(root, { recursive: true, force: true }))
    const store = await CharacterStore.open(root, true); const item = await store.create(character); const before = await store.readVersioned(item.id)
    const dir = join(root, item.id); const renameFile = fsPromises.rename; const removeFile = fsPromises.rm
    const renameMock = t.mock.method(fsPromises, 'rename', async (from: Parameters<typeof renameFile>[0], to: Parameters<typeof renameFile>[1]) => {
      const target = String(to)
      if ((stage === 'profile' && target === join(dir, 'profile.md')) || (stage === 'index' && target === join(root, 'index.json')) ||
          (stage === 'operation' && target === join(dir, 'initialization-operation.json'))) throw Object.assign(new Error(`故障 ${stage}`), { code: 'EIO' })
      await renameFile(from, to)
    })
    const removeMock = t.mock.method(fsPromises, 'rm', async (path: Parameters<typeof removeFile>[0], options?: Parameters<typeof removeFile>[1]) => {
      const target = String(path)
      if ((stage === 'backup-cleanup' && target === join(dir, 'initialization-backup.md')) ||
          (stage === 'operation-cleanup' && target === join(dir, 'initialization-operation.json'))) throw Object.assign(new Error(`故障 ${stage}`), { code: 'EIO' })
      await removeFile(path, options)
    })
    await assert.rejects(store.updateInitialization(item.id, before.version, { ...character, body: '新资料' }, 'initialization'), /故障/)
    renameMock.mock.restore(); removeMock.mock.restore(); await store.close()
    const recovery = await CharacterStore.open(root, false, true)
    try {
      assert.equal(await recovery.recoverInitialization(item.id), stage === 'profile' ? 'retry' : 'completed')
      assert.equal((await recovery.read(item.id)).body, stage === 'profile' ? '原始资料\n' : '新资料\n')
    } finally { await recovery.close() }
  }
})
