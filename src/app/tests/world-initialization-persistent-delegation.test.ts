import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { LlmAdapter, type GenerateOptions, type StreamChunk, type ToolCallId } from '@fly-novel/llm'
import configured = require('../call-llm.js')
import { createCharacterCreator, createWorldInitializationAgentWithWorkspace } from '../agents/index.js'

class ParentAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.requests.length % 2 === 1) {
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `task-${this.requests.length}` as ToolCallId,
        name: 'delegate_character_creator', arguments: JSON.stringify({ task: this.requests.length === 1 ? '创建调查者' : '继续完善调查者' }) } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '已收到建议' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

class ChildAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-end', index: 0, block: { type: 'text', text: `角色建议 ${this.requests.length}` } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

test('未装配角色 Agent 时主 Agent 可读取资料并自行规划', async t => {
  const parentDir = join(process.cwd(), 'tmp'); await mkdir(parentDir, { recursive: true })
  const root = await realpath(await mkdtemp(join(parentDir, 'world-without-creator-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const viewRoot = join(root, 'world'); const draftRoot = join(viewRoot, 'draft'); const confirmedRoot = join(viewRoot, 'confirmed')
  await mkdir(viewRoot); await mkdir(draftRoot); await mkdir(confirmedRoot)
  await writeFile(join(confirmedRoot, 'sea.md'), '外海暂不设定。')
  class PlanningAdapter extends LlmAdapter {
    readonly requests: GenerateOptions[] = []
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      this.requests.push(options)
      if (this.requests.length === 1) {
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'sea' as ToolCallId, name: 'read', arguments: '{"file_path":"confirmed/sea.md"}' } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else if (this.requests.length === 2) {
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'save' as ToolCallId, name: 'save_first_world_plan',
          arguments: JSON.stringify({ content: '用户留白：外海暂不设定。建议：城邦通过贸易分配有限能源。未来方向：贸易可能影响城邦关系。' }) } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        const result = options.messages.flatMap(message => message.content).find(block => block.type === 'tool-result' && block.toolCallId === 'save')
        assert.ok(result && result.type === 'tool-result' && !result.isError)
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '城邦资源规划；外海暂不设定。' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
  const adapter = new PlanningAdapter()
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'test', adapter }))
  const parent = await createWorldInitializationAgentWithWorkspace({ viewRoot, draftRoot, confirmedRoot })
  try {
    assert.equal(parent.context.tools.get('delegate_character_creator'), undefined)
    assert.deepEqual(await parent.run({ prompt: '规划资源有限的城邦群' }), { content: '城邦资源规划；外海暂不设定。' })
    const read = adapter.requests[1]?.messages.flatMap(message => message.content).find(block => block.type === 'tool-result' && block.toolCallId === 'sea')
    assert.ok(read && read.type === 'tool-result' && !read.isError)
    assert.match(JSON.stringify(read), /外海暂不设定/)
    const saved = adapter.requests[2]?.messages.flatMap(message => message.content).find(block => block.type === 'tool-result' && block.toolCallId === 'save')
    assert.ok(saved && saved.type === 'tool-result' && !saved.isError)
    assert.match(JSON.stringify(saved), /saved/)
  } finally { await parent.dispose() }
})

test('主 Agent 通过 persistent 委派角色创建，第二次恢复子 Session', async t => {
  const parentDir = join(process.cwd(), 'tmp'); await mkdir(parentDir, { recursive: true })
  const root = await realpath(await mkdtemp(join(parentDir, 'persistent-delegation-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const viewRoot = join(root, 'world'); const draftRoot = join(viewRoot, 'draft'); const confirmedRoot = join(viewRoot, 'confirmed')
  const characterRoot = join(viewRoot, 'characters'); const sessionRoot = join(root, 'sessions')
  await mkdir(viewRoot); await mkdir(draftRoot); await mkdir(confirmedRoot); await mkdir(characterRoot); await mkdir(sessionRoot)
  const parentAdapter = new ParentAdapter(); const childAdapter = new ChildAdapter()
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'test', adapter: parentAdapter }))
  const config = { worldId: 'world', agentId: 'creator', sessionId: 'session', sessionMode: 'create' as const,
    sessionRoot, characterRoot, initializeCharacters: true, readRoot: viewRoot,
    provider: 'child', model: 'test', adapter: childAdapter, defaultCharacterCount: 3 }
  const parent = await createWorldInitializationAgentWithWorkspace({ viewRoot, draftRoot, confirmedRoot }, config)
  try {
    assert.ok(parent.context.tools.get('delegate'))
    assert.ok(parent.context.tools.get('delegate_character_creator'))
    assert.deepEqual(await parent.run({ prompt: '父会话私有背景' }), { content: '已收到建议' })
    assert.deepEqual(await parent.run({ prompt: '请继续' }), { content: '已收到建议' })
    assert.match(JSON.stringify(childAdapter.requests[1]?.messages), /创建调查者/)
    assert.match(JSON.stringify(childAdapter.requests[1]?.messages), /继续完善调查者/)
    assert.doesNotMatch(JSON.stringify(childAdapter.requests[1]?.messages), /父会话私有背景/)
    assert.match(JSON.stringify(parentAdapter.requests[1]?.messages), /角色建议 1/)
  } finally { await parent.dispose() }
  const resumed = await createCharacterCreator({ ...config, sessionMode: 'resume', initializeCharacters: false })
  await resumed.dispose()
})

test('角色创建失败作为工具错误返回主 Agent，并释放角色身份', async t => {
  const parentDir = join(process.cwd(), 'tmp'); await mkdir(parentDir, { recursive: true })
  const root = await realpath(await mkdtemp(join(parentDir, 'persistent-child-failure-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const viewRoot = join(root, 'world'); const draftRoot = join(viewRoot, 'draft'); const confirmedRoot = join(viewRoot, 'confirmed')
  const characterRoot = join(viewRoot, 'characters'); const sessionRoot = join(root, 'sessions')
  await mkdir(viewRoot); await mkdir(draftRoot); await mkdir(confirmedRoot); await mkdir(characterRoot); await mkdir(sessionRoot)
  class FailedChild extends LlmAdapter {
    override async *stream(): AsyncIterable<StreamChunk> {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: '角色模型不可用', code: 'PROVIDER_ERROR' } } }
    }
  }
  class ReportingParent extends LlmAdapter {
    readonly requests: GenerateOptions[] = []
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      this.requests.push(options)
      if (this.requests.length === 1) {
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'task-1' as ToolCallId,
          name: 'delegate_character_creator', arguments: JSON.stringify({ task: '根据世界背景创建角色' }) } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        const result = options.messages.flatMap(message => message.content).find(block => block.type === 'tool-result' && block.toolCallId === 'task-1')
        assert.ok(result && result.type === 'tool-result' && result.isError)
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '角色任务失败，第一版尚未完成。' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
  const parentAdapter = new ReportingParent()
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'test', adapter: parentAdapter }))
  const config = { worldId: 'failure-world', agentId: 'creator', sessionId: 'session', sessionMode: 'create' as const,
    sessionRoot, characterRoot, initializeCharacters: true, readRoot: viewRoot,
    provider: 'child', model: 'test', adapter: new FailedChild(), defaultCharacterCount: 2 }
  const parent = await createWorldInitializationAgentWithWorkspace({ viewRoot, draftRoot, confirmedRoot }, config)
  try {
    assert.deepEqual(await parent.run({ prompt: '创建角色' }), { content: '角色任务失败，第一版尚未完成。' })
    const result = parentAdapter.requests[1]?.messages.flatMap(message => message.content).find(block => block.type === 'tool-result' && block.toolCallId === 'task-1')
    assert.ok(result && result.type === 'tool-result' && result.isError)
  } finally { await parent.dispose() }
  const resumed = await createCharacterCreator({ ...config, sessionMode: 'resume', initializeCharacters: false, adapter: new ChildAdapter() })
  await resumed.dispose()
})

test('可信装配拒绝角色目录与主 Agent 草稿根重叠', async t => {
  const parentDir = join(process.cwd(), 'tmp'); await mkdir(parentDir, { recursive: true })
  const root = await realpath(await mkdtemp(join(parentDir, 'persistent-overlap-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const viewRoot = join(root, 'world'); const draftRoot = join(viewRoot, 'draft'); const confirmedRoot = join(viewRoot, 'confirmed'); const sessionRoot = join(root, 'sessions')
  await mkdir(viewRoot); await mkdir(draftRoot); await mkdir(confirmedRoot); await mkdir(sessionRoot)
  await assert.rejects(createWorldInitializationAgentWithWorkspace({ viewRoot, draftRoot, confirmedRoot }, {
    worldId: 'world', agentId: 'creator', sessionId: 'session', sessionMode: 'create', sessionRoot,
    characterRoot: draftRoot, initializeCharacters: true, readRoot: viewRoot,
    provider: 'child', model: 'test', adapter: new ChildAdapter(), defaultCharacterCount: 3,
  }), /不能与草稿或已确认资料根重叠/)
})

test('父 Agent 销毁会取消持续子任务并释放角色 Agent', async t => {
  const parentDir = join(process.cwd(), 'tmp'); await mkdir(parentDir, { recursive: true })
  const root = await realpath(await mkdtemp(join(parentDir, 'persistent-close-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const viewRoot = join(root, 'world'); const draftRoot = join(viewRoot, 'draft'); const confirmedRoot = join(viewRoot, 'confirmed')
  const characterRoot = join(viewRoot, 'characters'); const sessionRoot = join(root, 'sessions')
  await mkdir(viewRoot); await mkdir(draftRoot); await mkdir(confirmedRoot); await mkdir(characterRoot); await mkdir(sessionRoot)
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  class WaitingAdapter extends LlmAdapter {
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      entered()
      await new Promise<void>((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true }))
    }
  }
  const parentAdapter = new ParentAdapter()
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'test', adapter: parentAdapter }))
  const config = { worldId: 'world-close', agentId: 'creator', sessionId: 'session', sessionMode: 'create' as const,
    sessionRoot, characterRoot, initializeCharacters: true, readRoot: viewRoot,
    provider: 'child', model: 'test', adapter: new WaitingAdapter(), defaultCharacterCount: 3 }
  const parent = await createWorldInitializationAgentWithWorkspace({ viewRoot, draftRoot, confirmedRoot }, config)
  const running = parent.run({ prompt: '创建角色' })
  const rejected = assert.rejects(running)
  await started
  await parent.dispose()
  await rejected
  const resumed = await createCharacterCreator({ ...config, sessionMode: 'resume', initializeCharacters: false, adapter: new ChildAdapter() })
  await resumed.dispose()
})
