import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
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
