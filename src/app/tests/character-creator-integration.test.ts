import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { LlmAdapter, type GenerateOptions, type StreamChunk, type ToolCallId } from '@fly-novel/llm'
import configured = require('../call-llm.js')
import { createWorldInitializationAgentWithWorkspace } from '../agents/index.js'
import { CharacterStore } from '../../world-init/character/store.js'

class ParentAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.requests.length % 2 === 1) {
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `delegate-${this.requests.length}` as ToolCallId,
        name: 'delegate_character_creator', arguments: JSON.stringify({ task: this.requests.length === 1 ? '根据世界资料创建两位角色' : '修改林岚，使其更谨慎' }) } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '已收到角色建议' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

class ChildAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const n = this.requests.length
    if (n === 1) {
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'background' as ToolCallId, name: 'read_file', arguments: '{"path":"world.md"}' } }
    } else if (n === 2) {
      for (const [index, name] of ['林岚', '沈秋'].entries()) {
        yield { type: 'block-end', index, block: { type: 'tool-call', id: `create-${index}` as ToolCallId, name: 'character_create',
          arguments: JSON.stringify({ character: { name, summary: '宗门调查者', categories: { faction: [{ id: 'sect', name: '青云宗' }] }, body: `${name}的原设定` } }) } }
      }
    } else if (n === 4) {
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'search' as ToolCallId, name: 'character_search', arguments: '{"filter":{"name":"林岚"}}' } }
    } else if (n === 5) {
      const result = options.messages.flatMap(message => message.content).find(block => block.type === 'tool-result' && block.toolCallId === 'search')
      assert.ok(result && result.type === 'tool-result' && !result.isError)
      const text = result.content.find(block => block.type === 'text')
      assert.ok(text && text.type === 'text')
      const data: unknown = JSON.parse(text.text)
      assert.ok(data && typeof data === 'object' && 'items' in data && Array.isArray(data.items))
      const id: unknown = data.items[0]?.id
      assert.equal(typeof id, 'string')
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'prepare' as ToolCallId, name: 'character_prepare',
        arguments: JSON.stringify({ id, character: { name: '林岚', summary: '宗门调查者', categories: { faction: [{ id: 'sect', name: '青云宗' }] }, body: '林岚的待审修改：更谨慎' } }) } }
    } else {
      yield { type: 'block-end', index: 0, block: { type: 'text', text: n === 3 ? '已创建两位角色建议' : '已准备待审修改' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

test('主子 Agent 经持久化会话创建角色、按名称查找并准备待审修改', async t => {
  const temp = join(process.cwd(), 'tmp'); await mkdir(temp, { recursive: true })
  const root = await realpath(await mkdtemp(join(temp, 'creator-full-chain-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const viewRoot = join(root, 'world'); const draftRoot = join(viewRoot, 'draft'); const confirmedRoot = join(viewRoot, 'confirmed')
  const characterRoot = join(viewRoot, 'characters'); const sessionRoot = join(root, 'sessions')
  await mkdir(viewRoot); await mkdir(draftRoot); await mkdir(confirmedRoot); await mkdir(characterRoot); await mkdir(sessionRoot)
  await writeFile(join(viewRoot, 'world.md'), '宗门禁止私自调查失踪事件。')
  const parentAdapter = new ParentAdapter(); const childAdapter = new ChildAdapter()
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'test', adapter: parentAdapter }))
  const parent = await createWorldInitializationAgentWithWorkspace({ viewRoot, draftRoot, confirmedRoot }, {
    worldId: 'world', agentId: 'creator', sessionId: 'session', sessionMode: 'create', sessionRoot, characterRoot,
    initializeCharacters: true, readRoot: viewRoot, provider: 'child', model: 'test', adapter: childAdapter, defaultCharacterCount: 3,
  })
  try {
    assert.deepEqual(await parent.run({ prompt: '请创建角色' }), { content: '已收到角色建议' })
    assert.deepEqual(await parent.run({ prompt: '请修改角色' }), { content: '已收到角色建议' })
    assert.match(JSON.stringify(childAdapter.requests[1]?.messages), /宗门禁止私自调查失踪事件/)
    assert.match(JSON.stringify(childAdapter.requests[3]?.messages), /根据世界资料创建两位角色/)
    assert.match(JSON.stringify(parentAdapter.requests[1]?.messages), /已创建两位角色建议/)
    assert.match(JSON.stringify(parentAdapter.requests[3]?.messages), /已准备待审修改/)
  } finally { await parent.dispose() }
  const store = await CharacterStore.open(characterRoot)
  try {
    const matches = await store.query({ categories: { faction: ['sect'] } })
    assert.equal(matches.length, 2)
    assert.equal(new Set(matches.map(item => item.id)).size, 2)
    assert.ok(matches.every(item => item.contentStatus === 'suggested'))
    const selected = matches.find(item => item.name === '林岚')!
    assert.equal((await store.read(selected.id)).body, '林岚的原设定\n')
    assert.equal((await store.readPending(selected.id)).document.body, '林岚的待审修改：更谨慎\n')
    assert.match(await readFile(join(characterRoot, selected.id, 'profile.md'), 'utf8'), /suggested/)
  } finally { await store.close() }
})

test('子 Agent 读取缺失资料失败后向主 Agent 报告缺口', async t => {
  const temp = join(process.cwd(), 'tmp'); await mkdir(temp, { recursive: true })
  const root = await realpath(await mkdtemp(join(temp, 'creator-missing-context-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const viewRoot = join(root, 'world'); const draftRoot = join(viewRoot, 'draft'); const confirmedRoot = join(viewRoot, 'confirmed')
  const characterRoot = join(viewRoot, 'characters'); const sessionRoot = join(root, 'sessions')
  await mkdir(viewRoot); await mkdir(draftRoot); await mkdir(confirmedRoot); await mkdir(characterRoot); await mkdir(sessionRoot)
  class MissingAdapter extends LlmAdapter {
    readonly requests: GenerateOptions[] = []
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      this.requests.push(options)
      if (this.requests.length === 1) {
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'missing' as ToolCallId, name: 'read_file', arguments: '{"path":"missing.md"}' } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '缺少世界背景，无法确认宗门限制' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
  const parentAdapter = new ParentAdapter(); const childAdapter = new MissingAdapter()
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'test', adapter: parentAdapter }))
  const parent = await createWorldInitializationAgentWithWorkspace({ viewRoot, draftRoot, confirmedRoot }, {
    worldId: 'missing-world', agentId: 'creator', sessionId: 'session', sessionMode: 'create', sessionRoot, characterRoot,
    initializeCharacters: true, readRoot: viewRoot, provider: 'child', model: 'test', adapter: childAdapter, defaultCharacterCount: 3,
  })
  try {
    await parent.run({ prompt: '需要角色' })
    const result = childAdapter.requests[1]?.messages.flatMap(message => message.content).find(block => block.type === 'tool-result' && block.toolCallId === 'missing')
    assert.ok(result && result.type === 'tool-result' && result.isError)
    assert.match(JSON.stringify(parentAdapter.requests[1]?.messages), /缺少世界背景/)
  } finally { await parent.dispose() }
  const store = await CharacterStore.open(characterRoot)
  try { assert.deepEqual(await store.query({}), []) } finally { await store.close() }
})
