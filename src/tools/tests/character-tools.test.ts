import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ToolCallId } from '@fly-novel/llm'
import { ToolsService } from '@fly-novel/tools'
import { CharacterStore } from '../../world-init/character-store.js'
import { createCharacterTools } from '../character/character-tools.js'

test('工具通过服务创建、查找和准备待审修改，不能由模型提交确认', async t => {
  const root = await mkdtemp(join(tmpdir(), 'character-tools-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = await CharacterStore.open(root, true)
  t.after(() => store.close())
  const tools = new ToolsService()
  for (const tool of createCharacterTools(store)) tools.register(tool)
  assert.equal(tools.get('character_commit'), undefined)
  const call = async (name: string, args: object) => (await tools.execute({
    calls: [{ type: 'tool-call', id: 'call' as ToolCallId, name, arguments: JSON.stringify(args) }],
    signal: new AbortController().signal, workingDirectory: root,
  })).results[0]!.result
  const character = { name: '林岚', summary: '调查者', categories: {}, body: '原设定' }
  const cancelled = new AbortController()
  cancelled.abort()
  const aborted = await tools.execute({ calls: [{ type: 'tool-call', id: 'cancel' as ToolCallId, name: 'character_create',
    arguments: JSON.stringify({ character }) }], signal: cancelled.signal, workingDirectory: root })
  assert.equal(aborted.results[0]?.result.isError, true)
  assert.equal((await store.query({})).length, 0)
  const created = await call('character_create', { character })
  assert.equal(created.isError, false)
  if (created.isError) throw new Error('创建失败')
  if (typeof created.value !== 'string') throw new Error('创建结果不是字符串')
  const id: string = JSON.parse(created.value).id
  const found = await call('character_search', { filter: { name: '林岚' } })
  assert.equal(found.isError, false)
  if (found.isError) throw new Error('查找失败')
  assert.match(String(found.value), new RegExp(id))
  const page = await call('character_search', { filter: {}, limit: 1 })
  if (page.isError || typeof page.value !== 'string') throw new Error('分页查询失败')
  const firstPage = JSON.parse(page.value)
  await call('character_create', { character: { ...character, name: '另一角色' } })
  const stale = await call('character_search', { filter: {}, offset: 1, limit: 1, version: firstPage.version })
  assert.equal(stale.isError, true)
  const invalid = await call('character_create', { character: { ...character, id } })
  assert.equal(invalid.isError, true)
  const prepared = await call('character_prepare', { id, character: { ...character, body: '修改建议' } })
  assert.equal(prepared.isError, false)
  assert.equal((await store.read(id)).body, '原设定\n')
  assert.equal((await store.readPending(id)).document.body, '修改建议\n')
})
