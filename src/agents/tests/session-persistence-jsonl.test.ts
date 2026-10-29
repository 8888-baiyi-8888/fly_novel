import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session } from '@fly-novel/session'
import { jsonlSessionPersistencePlugin } from '../plugins/session-persistence-jsonl/index.js'

test('JSONL 后端持久化事件并拒绝无效会话', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fly-session-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const { Context } = await import('@deepseek-ai/cordis')
  const root = new Context()
  const scope = root.plugin(jsonlSessionPersistencePlugin, { root: directory })
  await scope
  t.after(() => scope.dispose())
  const persistence = scope.ctx.sessionPersistence
  const header = { id: '../角色', createdAt: '2026-01-01T00:00:00.000Z' }
  const writer = await persistence.create(header)
  await assert.rejects(persistence.create(header), /已存在/)
  await assert.rejects(persistence.open('missing', 'read'), { code: 'ENOENT' })
  const source = new Session({ id: header.id })
  const first = source.append('turn/start', { turn: 1 })
  const second = source.append('step/start', { turn: 1, step: 1 })
  await writer.append([first])
  await writer.append([second])
  await assert.rejects(writer.append([first]), /序号不连续/)
  await writer.flush()
  await writer.close()
  const file = join(directory, `s-${Buffer.from(header.id).toString('base64url')}`, 'session.v2.jsonl')
  const text = await readFile(file, 'utf8')
  assert.equal(text.trimEnd().split('\n').length, 3)
  const reader = await persistence.open(header.id, 'read')
  assert.deepEqual((await reader.read()).events, [first, second])
  assert.deepEqual((await reader.read(1, 1)).events, [second])
  await assert.rejects(reader.append([]), /只读/)
  await reader.close()
  assert.deepEqual(await persistence.stat(header.id), { header })
  assert.deepEqual(await persistence.list(), [{ header }])
  const empty = await persistence.create({ id: 'empty', createdAt: header.createdAt })
  await empty.flush()
  await empty.close()
  assert.deepEqual((await (await persistence.open('empty', 'read')).read()).events, [])
  await writeFile(file, text.replace('"version":2', '"version":3'))
  await assert.rejects(persistence.open(header.id, 'read'), /版本不支持/)
  await writeFile(file, text.replace('"turn":1', '"turn":"bad"'))
  await assert.rejects(persistence.open(header.id, 'read'), /事件无效/)
  await writeFile(file, text.slice(0, -1))
  const truncated = await persistence.open(header.id, 'read')
  assert.deepEqual((await truncated.read()).events, [first])
  await truncated.close()
  assert.equal(await readFile(file, 'utf8'), text.slice(0, -1))
  const repaired = await persistence.open(header.id, 'write')
  assert.deepEqual((await repaired.read()).events, [first])
  await repaired.close()
  source.close()
})
