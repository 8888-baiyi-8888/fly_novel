import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { LlmAdapter, type GenerateOptions, type StreamChunk, type ToolCallId } from '@fly-novel/llm'
import { createCharacterCreator, type CharacterCreatorConfig } from '../agents/character-creator.js'

class CreatorAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly makeCharacter: boolean) { super() }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.makeCharacter && this.requests.length === 1) {
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'create' as ToolCallId, name: 'character_create',
        arguments: JSON.stringify({ character: { name: '林岚', summary: '调查者', categories: {}, body: '角色建议' } }) } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '角色任务完成' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function directories(t: { after(fn: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'character-creator-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const readRoot = join(root, 'world'); const characterRoot = join(readRoot, 'characters'); const sessionRoot = join(root, 'sessions')
  await mkdir(readRoot); await mkdir(characterRoot); await mkdir(sessionRoot)
  return { readRoot, characterRoot, sessionRoot }
}

test('独立角色创建 Agent 使用资料工具并在销毁重建后恢复会话', async t => {
  const roots = await directories(t)
  const adapter = new CreatorAdapter(true)
  const config: CharacterCreatorConfig = { ...roots, worldId: 'world-a', agentId: 'creator', sessionId: 'creator-session',
    sessionMode: 'create', initializeCharacters: true, provider: 'test', model: 'test', adapter, defaultCharacterCount: 3 }
  const first = await createCharacterCreator(config)
  await assert.rejects(createCharacterCreator({ ...config, initializeCharacters: false }), /正在使用/)
  assert.deepEqual(await first.run({ prompt: '创建调查者' }), { content: '角色任务完成' })
  assert.match(JSON.stringify(adapter.requests[0]?.messages), /角色设定创建 Agent/)
  assert.match(JSON.stringify(adapter.requests[1]?.messages), /林岚/)
  assert.match(await readFile(join(roots.characterRoot, 'index.json'), 'utf8'), /林岚/)
  await Promise.all([first.dispose(), first.dispose()])

  const resumedAdapter = new CreatorAdapter(false)
  const second = await createCharacterCreator({ ...config, sessionMode: 'resume', initializeCharacters: false, adapter: resumedAdapter })
  t.after(() => second.dispose())
  assert.deepEqual(await second.run({ prompt: '继续讨论角色' }), { content: '角色任务完成' })
  const messages = JSON.stringify(resumedAdapter.requests[0]?.messages)
  assert.match(messages, /创建调查者/)
  assert.match(messages, /林岚/)
  assert.match(messages, /继续讨论角色/)
})

test('Session 不存在或已存在时拒绝创建并释放身份', async t => {
  const roots = await directories(t)
  const config: CharacterCreatorConfig = { ...roots, worldId: 'world-b', agentId: 'creator', sessionId: 'session',
    sessionMode: 'resume', initializeCharacters: true, provider: 'test', model: 'test', adapter: new CreatorAdapter(false), defaultCharacterCount: 2 }
  await assert.rejects(createCharacterCreator(config))
  const agent = await createCharacterCreator({ ...config, sessionMode: 'create', initializeCharacters: false })
  await agent.dispose()
  await assert.rejects(createCharacterCreator({ ...config, sessionMode: 'create', initializeCharacters: false }), /已存在/)
  const resumed = await createCharacterCreator({ ...config, initializeCharacters: false })
  await resumed.dispose()
  await assert.rejects(createCharacterCreator({ ...config, worldId: 'other-world', initializeCharacters: false }))
})

test('取消正在运行的任务后可关闭并恢复会话', async t => {
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  class WaitingAdapter extends LlmAdapter {
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      entered()
      await new Promise<void>((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true })
      })
    }
  }
  const roots = await directories(t)
  const config: CharacterCreatorConfig = { ...roots, worldId: 'world-c', agentId: 'creator', sessionId: 'session',
    sessionMode: 'create', initializeCharacters: true, provider: 'test', model: 'test', adapter: new WaitingAdapter(), defaultCharacterCount: 2 }
  const agent = await createCharacterCreator(config)
  const running = agent.run({ prompt: '需要取消的任务' })
  await started
  agent.cancel()
  await assert.rejects(running)
  await agent.dispose()
  const resumed = await createCharacterCreator({ ...config, sessionMode: 'resume', initializeCharacters: false, adapter: new CreatorAdapter(false) })
  t.after(() => resumed.dispose())
  assert.deepEqual(await resumed.run({ prompt: '继续' }), { content: '角色任务完成' })
})
