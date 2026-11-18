import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { formatHistoryEvent, parseHistoryEvent, validateHistoryEventGraph, type HistoryEvent } from '@fly-novel/history'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const make = (n: number): HistoryEvent => ({ formatVersion: 1, worldId: 'world', id: id(n), name: '战争', aliases: [], detailLevel: 'overview', contentStatus: 'suggested',
  summary: '', body: '', time: [], parents: [], childrenCoverage: 'unknown', relations: [], references: [], publicAccounts: [], hidden: { state: 'unknown', note: '' }, reserved: [] })

test('历史格式保留时间基准、不确定性、独立引用与公开及隐藏内容', () => {
  const event: HistoryEvent = { ...make(1), time: [
    { kind: 'point', original: '约三百年前', basis: { kind: 'initialization' }, unit: 'year', value: -300, precision: 'approximate' },
    { kind: 'interval', original: '王朝末年', basis: { kind: 'era', id: 'dynasty' }, unit: 'year', start: 15, end: null, precision: 'approximate' },
    { kind: 'text', original: '战争结束之后' }],
    references: [{ type: 'person', kind: 'unresolved', description: '无名散修' }, { type: 'place', kind: 'linked', id: id(8), description: '山门' }],
    publicAccounts: [{ content: '因水源冲突', source: '城邦记载' }, { content: '另有说法', source: '' }], hidden: { state: 'unknown', note: '幕后原因未知' }, reserved: ['远方未展开'] }
  assert.deepEqual(parseHistoryEvent(formatHistoryEvent(event)), event)
  assert.throws(() => parseHistoryEvent(JSON.stringify({ ...event, formatVersion: 2 })))
  assert.throws(() => parseHistoryEvent('{"formatVersion":1,"formatVersion":1}'))
  assert.throws(() => parseHistoryEvent(JSON.stringify({ ...event, time: [{ kind: 'interval', original: '未知', basis: { kind: 'initialization' }, unit: 'year', start: null, end: null, precision: 'exact' }] })))
  assert.throws(() => parseHistoryEvent(JSON.stringify({ ...event, time: [{ kind: 'interval', original: '区间', basis: { kind: 'initialization' }, unit: 'year', start: 8, end: 2, precision: 'exact' }] })))
  assert.throws(() => parseHistoryEvent(JSON.stringify({ ...event, hidden: { state: 'unknown', content: '推测' } })))
})

test('真实目录中的事件支持同名、多上级及留白，拒绝缺失、跨世界和层级环并保留旧文件', async t => {
  const root = await mkdtemp(join(tmpdir(), 'history-contract-')); t.after(() => rm(root, { recursive: true, force: true }))
  const events = join(root, 'events'); await mkdir(events)
  const old = join(root, 'old-history.md'); await writeFile(old, '旧有历史正文，不自动迁移\n')
  const a = make(1); const b = { ...make(2), detailLevel: 'unexpanded' as const }
  const child = { ...make(3), name: '停战谈判', parents: [{ id: a.id, description: '结束第一场冲突' }, { id: b.id, description: '结束第二场冲突' }],
    relations: [{ kind: 'related' as const, targetId: a.id, description: '同一历史背景' }] }
  for (const event of [a, b, child]) await writeFile(join(events, `${event.id}.json`), formatHistoryEvent(event), { flag: 'wx' })
  const load = async () => Promise.all((await readdir(events)).map(async name => parseHistoryEvent(await readFile(join(events, name), 'utf8'))))
  const actual = await load(); validateHistoryEventGraph(actual, 'world')
  assert.equal(actual.filter(item => item.name === '战争').length, 2)
  assert.deepEqual(actual.find(item => item.id === child.id)?.parents.map(item => item.id), [a.id, b.id])
  assert.equal(actual.find(item => item.id === b.id)?.childrenCoverage, 'unknown')
  assert.throws(() => validateHistoryEventGraph(actual.filter(item => item.id !== a.id), 'world'), /不存在/)
  assert.throws(() => validateHistoryEventGraph(actual, 'other-world'), /世界不匹配/)
  assert.throws(() => validateHistoryEventGraph([...actual, a], 'world'), /ID 重复/)
  assert.throws(() => validateHistoryEventGraph([a, { ...b, parents: [{ id: child.id, description: '循环' }] }, child], 'world'), /循环/)
  const unknown = join(events, `${id(9)}.json`); await writeFile(unknown, '{"formatVersion":2}')
  await assert.rejects(load())
  assert.equal(await readFile(unknown, 'utf8'), '{"formatVersion":2}')
  assert.equal(await readFile(old, 'utf8'), '旧有历史正文，不自动迁移\n')
})
