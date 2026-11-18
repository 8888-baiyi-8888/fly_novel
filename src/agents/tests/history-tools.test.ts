import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@fly-novel/fs-local'
import type { ToolCallId } from '@fly-novel/llm'
import { ToolsService } from '@fly-novel/tools'
import { HistoryStore, createHistoryTools, historyToolsPlugin } from '@fly-novel/history'

test('历史插件在作用域内提供只读或读写工具，并按可信身份执行', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'history-tools-'))); t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'events')); await mkdir(join(root, 'candidates'))
  const context = new Context(); const fsScope = await context.plugin(LocalFileSystem, { cwd: root }); t.after(() => fsScope.dispose())
  const store = await HistoryStore.open({ fs: context.fs, root, worldId: 'world', phase: 'initialization', access: 'read-write', singleWriterProcess: true }); t.after(() => store.close())
  const service = new ToolsService({ id: 'historian', name: '历史', role: 'general' }); t.after(() => service.dispose())
  context.provide('tools', service)
  const readonly = await context.plugin(historyToolsPlugin, { store, access: 'read-only' })
  assert.ok(service.get('history_event_read')); assert.equal(service.get('history_event_create'), undefined)
  await readonly.dispose(); assert.equal(service.get('history_event_read'), undefined)
  const scope = await context.plugin(historyToolsPlugin, { store, access: 'read-write' })
  const call = async (name: string, args: object) => (await service.execute({ calls: [{ type: 'tool-call', id: 'call' as ToolCallId, name, arguments: JSON.stringify(args) }], workingDirectory: root, signal: new AbortController().signal })).results[0]!.result
  const content = { name: '战争', aliases: [], detailLevel: 'overview', summary: '', body: '', time: [], parents: [], childrenCoverage: 'unknown', relations: [], references: [], publicAccounts: [], hidden: { state: 'unknown', note: '' }, reserved: [] }
  const result = await call('history_event_create', { content }); assert.equal(result.isError, false)
  if (result.isError || !result.value || typeof result.value !== 'object' || Array.isArray(result.value) || typeof result.value.id !== 'string') throw new Error('事件创建结果无效')
  const id = result.value.id
  assert.equal((await call('history_event_read', { id })).isError, false)
  const child = await call('history_event_create', { content: { ...content, name: '谈判', parents: [{ id, description: '结束战争' }] } })
  assert.equal(child.isError, false)
  const children = await call('history_event_children', { id, depth: 1 })
  assert.equal(children.isError, false)
  if (children.isError || !children.value || typeof children.value !== 'object' || Array.isArray(children.value)) throw new Error('子事件查询结果无效')
  assert.match(JSON.stringify(children.value), /谈判/)
  const timeline = await call('history_timeline', {})
  assert.equal(timeline.isError, false)
  if (timeline.isError || !timeline.value || typeof timeline.value !== 'object' || Array.isArray(timeline.value)) throw new Error('时间线结果无效')
  assert.equal(timeline.value.complete, false)
  assert.equal((await call('history_event_create', { content: { ...content, worldId: 'other' } })).isError, true)
  assert.equal((await call('history_consistency_check', {})).isError, false)
  const write = context.fs.writeText.bind(context.fs)
  const mock = t.mock.method(context.fs, 'writeText', async (...args: Parameters<typeof write>) => { await write(...args); throw new Error('模拟发布后响应丢失') })
  const uncertain = await call('history_event_create', { content: { ...content, name: '待核查' } }); mock.mock.restore()
  assert.equal(uncertain.isError, false)
  if (uncertain.isError || !uncertain.value || typeof uncertain.value !== 'object' || Array.isArray(uncertain.value)) throw new Error('不确定结果无效')
  assert.equal(uncertain.value.status, 'unknown'); assert.match(String(uncertain.value.path), /^events\/[a-f0-9-]+\.json$/)
  const other = new ToolsService({ id: 'other', name: '其他', role: 'general' }); t.after(() => other.dispose())
  assert.ok(service.agent); for (const tool of createHistoryTools(store, service.agent!, 'read-only')) other.register(tool)
  const forged = await other.execute({ calls: [{ type: 'tool-call', id: 'forged' as ToolCallId, name: 'history_event_read', arguments: JSON.stringify({ id }) }], workingDirectory: root, signal: new AbortController().signal })
  assert.equal(forged.results[0]?.result.isError, true)
  await scope.dispose(); assert.equal(service.get('history_event_create'), undefined)
})
