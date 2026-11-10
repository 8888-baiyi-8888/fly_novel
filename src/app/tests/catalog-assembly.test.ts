import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { LlmAdapter, type GenerateOptions, type StreamChunk, type ToolCallId } from '@fly-novel/llm'
import configured = require('../call-llm.js')
import { createWorldInitializationAgentWithWorldWorkspaces } from '../agents/index.js'
import { initializeCatalog } from '../../world-init/workspace/catalog/format.js'
import type { WorldWorkspaceConfig } from '../../world-init/workspace/config.js'

class ParentAdapter extends LlmAdapter {
  override async *stream(): AsyncIterable<StreamChunk> {
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '完成' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
class ChildAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []
  alignment?: { path: string; revision: string }
  constructor(private readonly waitForCancel?: () => void) { super() }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.requests.length === 1) {
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'create' as ToolCallId, name: 'character_create',
        arguments: JSON.stringify({ character: { name: '角色甲', summary: '角色建议', categories: {}, body: '草案' } }) } }
    } else if (this.requests.length === 2) {
      const block = options.messages.flatMap(message => message.content).find(item => item.type === 'tool-result' && item.toolCallId === 'create')
      assert.ok(block && block.type === 'tool-result')
      const text = block.content.find(item => item.type === 'text'); assert.ok(text && text.type === 'text')
      const result: unknown = JSON.parse(text.text)
      assert.ok(result && typeof result === 'object' && 'id' in result && typeof result.id === 'string')
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'register' as ToolCallId, name: 'catalog_register',
        arguments: JSON.stringify({ path: `characters/${result.id}/profile.md`, summary: '角色甲的建议' }) } }
    } else if (this.alignment && this.requests.length === 4) {
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'source' as ToolCallId, name: 'catalog_read_source', arguments: JSON.stringify(this.alignment) } }
    } else if (this.alignment && this.requests.length === 5) {
      const block = options.messages.flatMap(message => message.content).find(item => item.type === 'tool-result' && item.toolCallId === 'source')
      assert.ok(block && block.type === 'tool-result' && !block.isError)
      const text = block.content.find(item => item.type === 'text'); assert.ok(text && text.type === 'text')
      const result: unknown = JSON.parse(text.text)
      assert.ok(result && typeof result === 'object' && 'receipt' in result && typeof result.receipt === 'string')
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'update' as ToolCallId, name: 'catalog_update',
        arguments: JSON.stringify({ ...this.alignment, receipt: result.receipt, summary: '更新后的角色简介' }) } }
    } else {
      if (this.waitForCancel) {
        this.waitForCancel()
        await new Promise<void>((_resolve, reject) => {
          if (options.signal?.aborted) reject(options.signal.reason)
          else options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true })
        })
        return
      }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '已登记角色建议' } }
      yield { type: 'finish', reason: { kind: 'stop' } }; return
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

test('世界入口共享目录服务给主子 Agent，子任务结束及父实例重建后保留记录', async t => {
  const temp = join(process.cwd(), 'tmp'); await mkdir(temp, { recursive: true })
  const root = await realpath(await mkdtemp(join(temp, 'catalog-assembly-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const worldRoot = join(root, 'world'); const sessionRoot = join(root, 'sessions')
  for (const dir of ['main', 'characters', 'catalog', 'confirmed']) await mkdir(join(worldRoot, dir), { recursive: true })
  await mkdir(sessionRoot)
  const world: WorldWorkspaceConfig = { worldId: 'catalog-assembly', readRoot: worldRoot, catalogRoot: join(worldRoot, 'catalog'),
    confirmedRoot: join(worldRoot, 'confirmed'), mainAgent: { agentId: 'main', writableRoot: join(worldRoot, 'main') },
    agents: [{ agentId: 'creator', writableRoot: join(worldRoot, 'characters') }] }
  await writeFile(join(worldRoot, 'main', 'world.md'), '世界草案')
  const adapter = new ParentAdapter(); const childAdapter = new ChildAdapter()
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'test', adapter }))
  const child = { agentId: 'creator', sessionId: 's', sessionMode: 'create' as const, sessionRoot, initializeCharacters: true,
    provider: 'test', model: 'test', adapter: childAdapter, defaultCharacterCount: 2 }
  const deployment = { singleWriterProcess: true, catalog: {} } as const
  await assert.rejects(createWorldInitializationAgentWithWorldWorkspaces([world], world.worldId, child, deployment))
  await initializeCatalog(world.catalogRoot, world.worldId)
  const parent = await createWorldInitializationAgentWithWorldWorkspaces([world], world.worldId, child, deployment)
  const call = async (name: string, args: object) => (await parent.context.tools.execute({ calls: [{ type: 'tool-call', id: 'test' as ToolCallId,
    name, arguments: JSON.stringify(args) }], workingDirectory: worldRoot, session: parent.context.sessions.list()[0]!, signal: new AbortController().signal })).results[0]!.result
  try {
    const section = parent.context.systemPrompt.getSection('world-initialization:catalog-alignment')
    assert.equal(typeof section?.text, 'string')
    assert.match(String(section?.text), /"owner":"creator","tool":"delegate_character_creator"/)
    assert.match(String(section?.text), /未列出的负责人没有已装配的委派工具/)
    assert.equal((await call('catalog_register', { path: 'main/world.md', summary: '世界草案' })).isError, false)
    assert.equal((await call('delegate_character_creator', { task: '创建并登记角色' })).isError, false)
    const result = childAdapter.requests[2]!.messages.flatMap(message => message.content).find(item => item.type === 'tool-result' && item.toolCallId === 'register')
    assert.ok(result && result.type === 'tool-result' && !result.isError)
    const search = await call('catalog_search', { ownerAgentId: 'creator' })
    assert.equal(search.isError, false)
    if (search.isError || !search.value || typeof search.value !== 'object' || Array.isArray(search.value)) throw new Error('查询失败')
    assert.equal(search.value.total, 1)
    const items = search.value.items
    assert.ok(Array.isArray(items) && items[0] && typeof items[0] === 'object' && !Array.isArray(items[0]))
    const record = items[0].record
    assert.ok(record && typeof record === 'object' && !Array.isArray(record) && typeof record.path === 'string' && typeof record.revision === 'string')
    const profilePath = join(worldRoot, ...record.path.split('/'))
    await writeFile(profilePath, (await readFile(profilePath, 'utf8')).replace('草案', '更新后的角色资料'))
    const before = await call('catalog_read', { path: record.path })
    assert.ok(!before.isError && before.value && typeof before.value === 'object' && !Array.isArray(before.value))
    assert.equal(before.value.fileStatus, 'stale')
    childAdapter.alignment = { path: record.path, revision: record.revision }
    assert.equal((await call('delegate_character_creator', { task: `更新 ${record.path} 的目录简介，原版本 ${record.revision}` })).isError, false)
    const after = await call('catalog_read', { path: record.path })
    assert.ok(!after.isError && after.value && typeof after.value === 'object' && !Array.isArray(after.value))
    assert.equal(after.value.fileStatus, 'current')
    assert.ok(after.value.record && typeof after.value.record === 'object' && !Array.isArray(after.value.record))
    assert.equal(after.value.record.summary, '更新后的角色简介'); assert.notEqual(after.value.record.revision, record.revision)
    assert.equal((await call('delegate_character_creator', { task: '继续角色任务', presetId: 'other', agentId: 'other' })).isError, false)
    assert.match(JSON.stringify(childAdapter.requests.at(-1)?.messages), /继续角色任务/)
    assert.equal((await call('write', { file_path: 'catalog/catalog.json', content: 'bad' })).isError, true)
  } finally { await parent.dispose() }
  const text = await readFile(join(world.catalogRoot, 'catalog.json'), 'utf8')
  assert.match(text, /更新后的角色简介/); assert.match(text, /世界草案/)
  const resumed = await createWorldInitializationAgentWithWorldWorkspaces([world], world.worldId, { ...child, sessionMode: 'resume', initializeCharacters: false }, deployment)
  await resumed.dispose()
  const withoutCreator = await createWorldInitializationAgentWithWorldWorkspaces([world], world.worldId, undefined, deployment)
  try {
    assert.equal(withoutCreator.context.tools.get('delegate_character_creator'), undefined)
    const section = withoutCreator.context.systemPrompt.getSection('world-initialization:catalog-alignment')
    assert.match(String(section?.text), /映射（owner、tool）为 \[\]/)
    assert.doesNotMatch(String(section?.text), /"owner":"creator"/)
  } finally { await withoutCreator.dispose() }
})

test('父 Agent 取消角色任务时等待目录操作并释放服务', async t => {
  const temp = join(process.cwd(), 'tmp'); await mkdir(temp, { recursive: true })
  const root = await realpath(await mkdtemp(join(temp, 'catalog-close-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const worldRoot = join(root, 'world'); const sessionRoot = join(root, 'sessions')
  for (const dir of ['main', 'characters', 'catalog', 'confirmed']) await mkdir(join(worldRoot, dir), { recursive: true })
  await mkdir(sessionRoot)
  const world: WorldWorkspaceConfig = { worldId: 'catalog-close', readRoot: worldRoot, catalogRoot: join(worldRoot, 'catalog'),
    confirmedRoot: join(worldRoot, 'confirmed'), mainAgent: { agentId: 'main', writableRoot: join(worldRoot, 'main') },
    agents: [{ agentId: 'creator', writableRoot: join(worldRoot, 'characters') }] }
  await initializeCatalog(world.catalogRoot, world.worldId)
  let enter!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const child = { agentId: 'creator', sessionId: 's', sessionMode: 'create' as const, sessionRoot, initializeCharacters: true,
    provider: 'test', model: 'test', adapter: new ChildAdapter(enter), defaultCharacterCount: 2 }
  class DelegateAdapter extends LlmAdapter {
    override async *stream(): AsyncIterable<StreamChunk> {
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'delegate' as ToolCallId,
        name: 'delegate_character_creator', arguments: JSON.stringify({ task: '创建并登记角色' }) } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
  }
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'test', adapter: new DelegateAdapter() }))
  const deployment = { singleWriterProcess: true, catalog: {} } as const
  const parent = await createWorldInitializationAgentWithWorldWorkspaces([world], world.worldId, child, deployment)
  const running = parent.run({ prompt: '创建角色' })
  const rejected = assert.rejects(running)
  await entered
  await parent.dispose(); await rejected
  assert.match(await readFile(join(world.catalogRoot, 'catalog.json'), 'utf8'), /角色甲的建议/)
  const resumed = await createWorldInitializationAgentWithWorldWorkspaces([world], world.worldId, { ...child, sessionMode: 'resume', initializeCharacters: false, adapter: new ChildAdapter() }, deployment)
  await resumed.dispose()
})
