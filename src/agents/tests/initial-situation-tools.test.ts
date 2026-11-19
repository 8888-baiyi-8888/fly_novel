import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@fly-novel/fs-local'
import { ToolsService } from '@fly-novel/tools'
import type { ToolCallId } from '@fly-novel/llm'
import { SituationStore, SituationQueries, situationToolsPlugin } from '@fly-novel/initial-situation'

test('局势工具绑定身份并支持方案、条目、查询和版本检查', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'situation-tools-'))); t.after(() => rm(root, { recursive: true, force: true }))
  for (const name of ['overviews', 'situations', 'candidates']) await mkdir(join(root, name))
  const ctx = new Context(); const fs = await ctx.plugin(LocalFileSystem, { cwd: root }); t.after(() => fs.dispose())
  const refId = '00000000-0000-4000-8000-000000000001'
  const store = await SituationStore.open({ fs: ctx.fs, root, worldId: 'world', phase: 'initialization', access: 'read-write', singleWriterProcess: true, resolveReference: async (_type, id) => id === refId ? { id, worldId: 'world', version: 'v2' } : null }); t.after(() => store.close())
  const service = new ToolsService({ id: 'planner', name: '局势', role: 'general' }); t.after(() => service.dispose()); ctx.provide('tools', service)
  const readonly = await ctx.plugin(situationToolsPlugin, { store, access: 'read-only' }); assert.equal(service.get('situation_create'), undefined); await readonly.dispose()
  const scope = await ctx.plugin(situationToolsPlugin, { store, access: 'read-write' })
  const call = async (name: string, args: object) => (await service.execute({ calls: [{ type: 'tool-call', id: 'call' as ToolCallId, name, arguments: JSON.stringify(args) }], workingDirectory: root, signal: new AbortController().signal })).results[0]!.result
  assert.equal((await call('situation_start_create', { description: '战后' })).isError, false)
  const created = await call('situation_overview_create', { content: { name: '城邦', summary: '', coverage: '河谷', reserved: [] } }); assert.equal(created.isError, false)
  if (!created.value || typeof created.value !== 'object' || Array.isArray(created.value) || typeof created.value.id !== 'string') throw new Error('方案结果无效')
  const overviewId = created.value.id
  const content = { overviewId, name: '供水', aliases: [], detailLevel: 'overview', summary: '', body: '', references: [{ kind: 'linked', type: 'place', id: refId, description: '', observedVersion: 'v1' }], relations: [], reserved: [] }
  assert.equal((await call('situation_create', { content })).isError, false); assert.equal((await call('situation_create', { content: { ...content, name: '谈判' } })).isError, false)
  const query = new SituationQueries(store); const page = await query.search({ overviewId, limit: 1 }); assert.equal(page.total, 2)
  assert.equal((await store.checkReference('place', refId, 'v1')).status, 'changed'); assert.equal((await store.checkReference('place', refId, null)).status, 'version_unknown')
  assert.equal((await store.checkReference('place', '00000000-0000-4000-8000-000000000002', 'v1')).status, 'not_found')
  await store.createSituation({ ...content, name: '新增', detailLevel: 'overview', references: [], relations: [] })
  await assert.rejects(query.search({ overviewId, offset: 1, limit: 1, version: page.version }), { code: 'SITUATION_CONFLICT' })
  assert.equal((await call('situation_consistency_check', {})).isError, false)
  await scope.dispose(); assert.equal(service.get('situation_create'), undefined)
})
