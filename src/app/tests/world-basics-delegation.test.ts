import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { LlmAdapter, type GenerateOptions, type StreamChunk, type ToolCallId } from '@fly-novel/llm'
import configured = require('../call-llm.js')
import { createWorldInitializationAgentWithWorldWorkspaces } from '../agents/index.js'
import { initializeCatalog } from '../../world-init/workspace/catalog/format.js'

class ParentAdapter extends LlmAdapter {
  override async *stream(): AsyncIterable<StreamChunk> {
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '完成' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class BasicsAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.requests.length === 1) {
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'save' as ToolCallId, name: 'save_world_basics', arguments: JSON.stringify({ content: '用户要求：力量无善恶。建议：宗门各有目标。' }) } }
    } else if (this.requests.length === 2) {
      const result = options.messages.flatMap(message => message.content).find(block => block.type === 'tool-result' && block.toolCallId === 'save')
      assert.ok(result && result.type === 'tool-result' && !result.isError)
      const path = JSON.stringify(result).match(/basics\/world-basics-[a-f0-9-]+\.md/)
      assert.ok(path)
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'register' as ToolCallId, name: 'catalog_register', arguments: JSON.stringify({ path: path[0], summary: '世界基础信息' }) } }
    } else {
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '基础信息建议已处理' } }
      yield { type: 'finish', reason: { kind: 'stop' } }; return
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

test('主 Agent 同时装配两个专用委派，基础信息保存、登记并恢复会话', async t => {
  const temp = join(process.cwd(), 'tmp'); await mkdir(temp, { recursive: true })
  const root = await realpath(await mkdtemp(join(temp, 'basics-delegate-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const readRoot = join(root, 'world'); const sessionRoot = join(root, 'sessions')
  for (const name of ['main', 'basics', 'characters', 'catalog', 'confirmed']) await mkdir(join(readRoot, name), { recursive: true })
  await mkdir(sessionRoot)
  const world = { worldId: 'world', readRoot, confirmedRoot: join(readRoot, 'confirmed'), catalogRoot: join(readRoot, 'catalog'),
    mainAgent: { agentId: 'main', writableRoot: join(readRoot, 'main') }, agents: [
      { agentId: 'basics', writableRoot: join(readRoot, 'basics') }, { agentId: 'creator', writableRoot: join(readRoot, 'characters') },
    ] }
  await initializeCatalog(world.catalogRoot, world.worldId)
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'test', adapter: new ParentAdapter() }))
  const adapter = new BasicsAdapter()
  const common = { sessionRoot, sessionMode: 'create' as const, provider: 'test', model: 'test' }
  const creator = { ...common, agentId: 'creator', sessionId: 'creator', adapter: new ParentAdapter(), initializeCharacters: true, defaultCharacterCount: 1 }
  const basics = { ...common, agentId: 'basics', sessionId: 'basics', adapter }
  const parent = await createWorldInitializationAgentWithWorldWorkspaces([world], world.worldId, creator, { singleWriterProcess: true, catalog: {}, worldBasics: basics })
  try {
    const call = async (name: string, args: object) => (await parent.context.tools.execute({ calls: [{ type: 'tool-call', id: 'call' as ToolCallId, name, arguments: JSON.stringify(args) }],
      workingDirectory: readRoot, session: parent.context.sessions.list()[0]!, signal: new AbortController().signal })).results[0]!.result
    assert.ok(parent.context.tools.get('delegate_world_basics'))
    assert.ok(parent.context.tools.get('delegate_character_creator'))
    assert.match(String(parent.context.systemPrompt.getSection('world-initialization:world-basics')?.text), /delegate_world_basics/)
    assert.match(String(parent.context.systemPrompt.getSection('world-initialization:catalog-alignment')?.text), /delegate_world_basics/)
    assert.equal((await call('delegate_world_basics', { task: '规划修仙世界，力量无善恶' })).isError, false)
    assert.match(await readFile(join(world.catalogRoot, 'catalog.json'), 'utf8'), /世界基础信息/)
    const found = await call('catalog_search', { ownerAgentId: 'basics' })
    assert.ok(!found.isError && found.value && typeof found.value === 'object' && !Array.isArray(found.value))
    assert.equal(found.value.total, 1)
    assert.equal((await call('delegate_world_basics', { task: '继续检查已有建议' })).isError, false)
    assert.match(JSON.stringify(adapter.requests.at(-1)?.messages), /规划修仙世界/)
    assert.equal((await call('delegate_character_creator', { task: '分析角色需求' })).isError, false)
    assert.equal((await call('delegate_world_basics', { task: ' ', worldId: 'other' })).isError, true)
  } finally { await parent.dispose() }
})

test('未配置时不暴露基础信息委派；子任务失败和父 Agent 关闭后释放身份', { timeout: 10000 }, async t => {
  const temp = join(process.cwd(), 'tmp'); await mkdir(temp, { recursive: true })
  const root = await realpath(await mkdtemp(join(temp, 'basics-failure-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const readRoot = join(root, 'world'); const sessionRoot = join(root, 'sessions')
  for (const name of ['main', 'basics', 'catalog', 'confirmed']) await mkdir(join(readRoot, name), { recursive: true })
  await mkdir(sessionRoot)
  const world = { worldId: 'failure-world', readRoot, confirmedRoot: join(readRoot, 'confirmed'), catalogRoot: join(readRoot, 'catalog'),
    mainAgent: { agentId: 'main', writableRoot: join(readRoot, 'main') }, agents: [{ agentId: 'basics', writableRoot: join(readRoot, 'basics') }] }
  class DelegatingParent extends LlmAdapter {
    override async *stream(): AsyncIterable<StreamChunk> {
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'delegate' as ToolCallId, name: 'delegate_world_basics', arguments: JSON.stringify({ task: '规划世界' }) } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
  }
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'test', adapter: new DelegatingParent() }))
  const noChild = await createWorldInitializationAgentWithWorldWorkspaces([world], world.worldId, undefined, { singleWriterProcess: true })
  assert.equal(noChild.context.tools.get('delegate_world_basics'), undefined)
  await noChild.dispose()
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  let wait = false
  class FailureAdapter extends LlmAdapter {
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      if (!wait) { yield { type: 'finish', reason: { kind: 'error', failure: { message: '模拟失败', code: 'PROVIDER_ERROR' } } }; return }
      entered()
      if (!options.signal?.aborted) await new Promise<void>(resolve => options.signal?.addEventListener('abort', () => resolve(), { once: true }))
      yield { type: 'finish', reason: { kind: 'aborted', failure: { message: '取消', code: 'ABORTED' } } }
    }
  }
  const basics = { agentId: 'basics', sessionId: 's', sessionRoot, sessionMode: 'create' as const, provider: 'test', model: 'test', adapter: new FailureAdapter() }
  const parent = await createWorldInitializationAgentWithWorldWorkspaces([world], world.worldId, undefined, { singleWriterProcess: true, worldBasics: basics })
  const call = () => parent.context.tools.execute({ calls: [{ type: 'tool-call', id: 'call' as ToolCallId, name: 'delegate_world_basics', arguments: JSON.stringify({ task: '规划世界' }) }],
    workingDirectory: readRoot, session: parent.context.sessions.list()[0]!, signal: new AbortController().signal })
  assert.equal((await call()).results[0]!.result.isError, true)
  wait = true
  const pending = parent.run({ prompt: '规划世界' })
  const rejected = assert.rejects(pending)
  await started
  await parent.dispose()
  await rejected
  const { createWorldBasicsAgent } = await import('../agents/world-basics.js')
  const resumed = await createWorldBasicsAgent({ ...basics, workspaces: [world], worldId: world.worldId, singleWriterProcess: true, sessionMode: 'resume', adapter: new ParentAdapter() })
  await resumed.dispose()
})
