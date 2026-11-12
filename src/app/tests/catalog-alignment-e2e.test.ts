import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { LlmAdapter, type GenerateOptions, type StreamChunk, type ToolCallId } from '@fly-novel/llm'
import configured = require('../call-llm.js')
import { createWorldInitializationAgentWithWorldWorkspaces } from '../agents/index.js'
import { CharacterStore } from '../../world-init/character/store.js'
import { initializeCatalog } from '../../world-init/workspace/catalog/format.js'
import { CatalogService } from '../../world-init/workspace/catalog/service.js'
import type { WorldWorkspaceConfig } from '../../world-init/workspace/config.js'

function toolResult(options: GenerateOptions, id: string): Record<string, unknown> {
  const block = options.messages.flatMap(message => message.content).find(item => item.type === 'tool-result' && item.toolCallId === id)
  assert.ok(block && block.type === 'tool-result' && !block.isError)
  const content = block.content.find(item => item.type === 'text'); assert.ok(content && content.type === 'text')
  const value: unknown = JSON.parse(content.text)
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}

function call(id: string, name: string, args: object): StreamChunk {
  return { type: 'block-end', index: 0, block: { type: 'tool-call', id: id as ToolCallId, name, arguments: JSON.stringify(args) } }
}

class ParentAdapter extends LlmAdapter {
  step = 0
  mainRevision = ''
  childRevision = ''
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const step = this.step++
    if (step === 0) yield call('check', 'catalog_check_page', {})
    else if (step === 1) {
      const page = toolResult(options, 'check')
      assert.equal(page.status, 'completed'); assert.equal(page.nextOffset, null)
      assert.ok(Array.isArray(page.items)); assert.equal(page.items.length, 2)
      for (const item of page.items) {
        assert.equal(item.fileStatus, 'stale')
        if (item.record.ownerAgentId === 'main') this.mainRevision = item.record.revision
        if (item.record.ownerAgentId === 'creator') this.childRevision = item.record.revision
      }
      assert.ok(this.mainRevision && this.childRevision)
      yield call('main-source', 'catalog_read_source', { path: 'main/world.md', revision: this.mainRevision })
    } else if (step === 2) {
      const source = toolResult(options, 'main-source'); assert.equal(source.content, '新的世界资料')
      yield call('main-update', 'catalog_update', { path: 'main/world.md', revision: this.mainRevision, receipt: source.receipt, summary: '世界新简介' })
    } else if (step === 3) {
      assert.equal(toolResult(options, 'main-update').fileStatus, 'current')
      yield call('main-verify', 'catalog_read', { path: 'main/world.md' })
    } else if (step === 4) {
      assert.equal(toolResult(options, 'main-verify').fileStatus, 'current')
      yield call('child-before', 'catalog_read', { path: 'characters/work.md' })
    } else if (step === 5) {
      assert.equal(toolResult(options, 'child-before').fileStatus, 'stale')
      yield call('delegate', 'delegate_character_creator', { task: `更新 characters/work.md 的目录简介，revision ${this.childRevision}` })
    } else if (step === 6) {
      const block = options.messages.flatMap(message => message.content).find(item => item.type === 'tool-result' && item.toolCallId === 'delegate')
      assert.ok(block && block.type === 'tool-result' && !block.isError)
      yield call('child-verify', 'catalog_read', { path: 'characters/work.md' })
    } else {
      const result = toolResult(options, 'child-verify'); assert.equal(result.fileStatus, 'current')
      assert.ok(result.record && typeof result.record === 'object' && 'revision' in result.record)
      assert.notEqual(result.record.revision, this.childRevision)
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '两项检查并复核完成' } }
      yield { type: 'finish', reason: { kind: 'stop' } }; return
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

class ChildAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []
  revision = ''
  receipt = ''
  unusedRevision = ''
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const step = this.requests.length
    if (step === 1) yield call('child-source', 'catalog_read_source', { path: 'characters/work.md', revision: this.revision })
    else if (step === 2) {
      const source = toolResult(options, 'child-source'); assert.equal(source.content, '新的角色资料')
      assert.equal(typeof source.receipt, 'string'); this.receipt = String(source.receipt)
      yield call('child-update', 'catalog_update', { path: 'characters/work.md', revision: this.revision, receipt: this.receipt, summary: '角色新简介' })
    } else if (step === 3) {
      const updated = toolResult(options, 'child-update'); assert.equal(updated.fileStatus, 'current')
      assert.ok(updated.record && typeof updated.record === 'object' && 'revision' in updated.record && typeof updated.record.revision === 'string')
      this.unusedRevision = updated.record.revision
      yield call('unused-source', 'catalog_read_source', { path: 'characters/work.md', revision: this.unusedRevision })
    } else if (step === 4) {
      const source = toolResult(options, 'unused-source'); assert.equal(typeof source.receipt, 'string'); this.receipt = String(source.receipt)
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '角色简介已更新' } }
      yield { type: 'finish', reason: { kind: 'stop' } }; return
    } else if (step === 5) {
      assert.match(JSON.stringify(options.messages), /更新 characters\/work.md 的目录简介/)
      yield call('old-receipt', 'catalog_update', { path: 'characters/work.md', revision: this.unusedRevision, receipt: this.receipt, summary: '无效更新' })
    } else {
      const block = options.messages.flatMap(message => message.content).find(item => item.type === 'tool-result' && item.toolCallId === 'old-receipt')
      assert.ok(block && block.type === 'tool-result' && block.isError)
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '旧凭据已失效' } }
      yield { type: 'finish', reason: { kind: 'stop' } }; return
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

test('真实主子 Agent 从检查到委派及复查，重建后恢复 Session 并撤销旧凭据', async t => {
  const temp = join(process.cwd(), 'tmp'); await mkdir(temp, { recursive: true })
  const root = await realpath(await mkdtemp(join(temp, 'catalog-e2e-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const worldRoot = join(root, 'world'); const sessions = join(root, 'sessions')
  for (const dir of ['main', 'characters', 'catalog', 'confirmed']) await mkdir(join(worldRoot, dir), { recursive: true })
  await mkdir(sessions)
  const world: WorldWorkspaceConfig = { worldId: 'alignment-e2e', readRoot: worldRoot, catalogRoot: join(worldRoot, 'catalog'),
    confirmedRoot: join(worldRoot, 'confirmed'), mainAgent: { agentId: 'main', writableRoot: join(worldRoot, 'main') },
    agents: [{ agentId: 'creator', writableRoot: join(worldRoot, 'characters') }] }
  await initializeCatalog(world.catalogRoot, world.worldId)
  const store = await CharacterStore.open(world.agents[0]!.writableRoot, true); await store.close()
  await writeFile(join(worldRoot, 'main', 'world.md'), '旧世界')
  await writeFile(join(worldRoot, 'characters', 'work.md'), '旧角色')
  const catalog = await CatalogService.open(world, { singleWriterProcess: true })
  const main = catalog.bind('main'); const child = catalog.bind('creator')
  await main.register('main/world.md', '旧世界简介')
  const record = (await child.register('characters/work.md', '旧角色简介')).record
  await catalog.close()
  await writeFile(join(worldRoot, 'main', 'world.md'), '新的世界资料')
  await writeFile(join(worldRoot, 'characters', 'work.md'), '新的角色资料')
  const parentAdapter = new ParentAdapter(); const childAdapter = new ChildAdapter(); childAdapter.revision = record.revision
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'test', adapter: parentAdapter }))
  const parent = await createWorldInitializationAgentWithWorldWorkspaces([world], world.worldId,
    { agentId: 'creator', sessionId: 'session', sessionMode: 'create', sessionRoot: sessions, initializeCharacters: false,
      provider: 'test', model: 'test', adapter: childAdapter, defaultCharacterCount: 2 }, { singleWriterProcess: true, catalog: {} })
  try {
    assert.deepEqual(await parent.run({ prompt: '检查并更新资料简介' }), { content: '两项检查并复核完成' })
    const result = (await parent.context.tools.execute({ calls: [{ type: 'tool-call', id: 'again' as ToolCallId, name: 'delegate_character_creator',
      arguments: JSON.stringify({ task: '再次检查旧凭据' }) }], workingDirectory: worldRoot, session: parent.context.sessions.list()[0]!,
      signal: new AbortController().signal })).results[0]!.result
    assert.equal(result.isError, false)
    assert.match(await readFile(join(world.catalogRoot, 'catalog.json'), 'utf8'), /角色新简介/)
    assert.equal(await readFile(join(worldRoot, 'characters', 'work.md'), 'utf8'), '新的角色资料')
  } finally { await parent.dispose() }
})

test('负责人未配置时主 Agent 保留已完成项并报告未处理项', async t => {
  const temp = join(process.cwd(), 'tmp'); await mkdir(temp, { recursive: true })
  const root = await realpath(await mkdtemp(join(temp, 'catalog-partial-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const dir of ['main', 'other', 'catalog', 'confirmed']) await mkdir(join(root, dir))
  const world: WorldWorkspaceConfig = { worldId: 'alignment-partial', readRoot: root, catalogRoot: join(root, 'catalog'),
    confirmedRoot: join(root, 'confirmed'), mainAgent: { agentId: 'main', writableRoot: join(root, 'main') },
    agents: [{ agentId: 'other', writableRoot: join(root, 'other') }] }
  await initializeCatalog(world.catalogRoot, world.worldId)
  await writeFile(join(root, 'main', 'world.md'), '旧世界'); await writeFile(join(root, 'other', 'work.md'), '旧资料')
  const catalog = await CatalogService.open(world, { singleWriterProcess: true })
  const main = catalog.bind('main'); const other = catalog.bind('other')
  const mainRecord = (await main.register('main/world.md', '旧世界简介')).record
  await other.register('other/work.md', '旧资料简介'); await catalog.close()
  await writeFile(join(root, 'main', 'world.md'), '新世界'); await writeFile(join(root, 'other', 'work.md'), '新资料')
  class PartialAdapter extends LlmAdapter {
    step = 0
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      const step = this.step++
      if (step === 0) yield call('check', 'catalog_check_page', {})
      else if (step === 1) {
        const page = toolResult(options, 'check'); assert.ok(Array.isArray(page.items))
        assert.equal(page.items.length, 2); assert.ok(page.items.every(item => item.fileStatus === 'stale'))
        assert.ok(page.items.some(item => item.record.ownerAgentId === 'other'))
        yield call('source', 'catalog_read_source', { path: mainRecord.path, revision: mainRecord.revision })
      } else if (step === 2) {
        const source = toolResult(options, 'source')
        yield call('update', 'catalog_update', { path: mainRecord.path, revision: mainRecord.revision, receipt: source.receipt, summary: '新世界简介' })
      } else if (step === 3) {
        assert.equal(toolResult(options, 'update').fileStatus, 'current')
        yield call('verify', 'catalog_read', { path: mainRecord.path })
      } else {
        assert.equal(toolResult(options, 'verify').fileStatus, 'current')
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '世界简介已对齐；other 未配置，资料未处理' } }
        yield { type: 'finish', reason: { kind: 'stop' } }; return
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
  }
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'test', adapter: new PartialAdapter() }))
  const parent = await createWorldInitializationAgentWithWorldWorkspaces([world], world.worldId, undefined, { singleWriterProcess: true, catalog: {} })
  try {
    assert.equal(parent.context.tools.get('delegate_character_creator'), undefined)
    assert.match(String(parent.context.systemPrompt.getSection('world-initialization:catalog-alignment')?.text), /映射（owner、tool）为 \[\]/)
    assert.deepEqual(await parent.run({ prompt: '检查资料' }), { content: '世界简介已对齐；other 未配置，资料未处理' })
    const data = await readFile(join(world.catalogRoot, 'catalog.json'), 'utf8')
    assert.match(data, /新世界简介/); assert.match(data, /旧资料简介/)
    assert.equal(await readFile(join(root, 'other', 'work.md'), 'utf8'), '新资料')
  } finally { await parent.dispose() }
})
