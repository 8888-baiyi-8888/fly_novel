import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LlmAdapter, type GenerateOptions, type StreamChunk, type ToolCallId } from '@fly-novel/llm'
import { ToolsService, type ToolDefinition } from '@fly-novel/tools'
import configured = require('../call-llm.js')
import { createCharacterAgent, createDirectorAgent, createWorldInitializationAgent, createWriterAgent } from '../agents/index.js'

class Adapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '完成' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

test('各 Agent 创建函数自行读取配置并创建独立实例', async (t) => {
  const adapter = new Adapter()
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'test', adapter }))
  const world = await createWorldInitializationAgent()
  const another = await createWorldInitializationAgent()
  const character = await createCharacterAgent()
  const director = await createDirectorAgent()
  const writer = await createWriterAgent()
  try {
    assert.notEqual(world.info.identity.id, another.info.identity.id)
    assert.notEqual(world.context.skills, another.context.skills)
    assert.equal(world.info.identity.role, 'world-initialization-main')
    assert.equal(character.info.identity.role, 'character')
    assert.equal(director.info.identity.role, 'director')
    assert.equal(writer.info.identity.role, 'writer')
    assert.ok(world.context.tools.get('skill'))
    assert.ok(world.context.tools.get('read_file'))
    assert.ok(another.context.tools.get('read_file'))
    assert.equal(character.context.get('tools'), undefined)
    assert.deepEqual(await world.run({ prompt: '构想' }), { content: '完成' })
    assert.ok(adapter.requests[0]?.tools?.some(tool => tool.name === 'read_file'))
    const result = await world.context.tools.execute({
      calls: [{ type: 'tool-call', id: 'read' as ToolCallId, name: 'read_file', arguments: '{"path":"README.md"}' }],
      signal: new AbortController().signal,
      workingDirectory: process.cwd(),
    })
    const read = result.results[0]?.result
    assert.ok(read && !read.isError)
    assert.match(String(read.value), /fly_novel/)
    assert.deepEqual(await character.run({ prompt: '你好' }), { content: '完成' })
  } finally {
    await world.dispose()
    await another.dispose()
    await character.dispose()
    await director.dispose()
    await writer.dispose()
  }
  assert.equal(world.state, 'disposed')
  assert.equal(another.state, 'disposed')
})

test('世界初始化 Agent 的模型配置读取失败时明确报错', async (t) => {
  t.mock.method(configured, 'loadConfiguredAdapter', async () => { throw new Error('模型配置不可用') })
  await assert.rejects(createWorldInitializationAgent(), /模型配置不可用/)
})

test('所有工具注册失败时记录各自错误，Agent 仍可创建和运行', async (t) => {
  const adapter = new Adapter()
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'test', adapter }))
  t.mock.method(ToolsService.prototype, 'register', () => { throw new Error('测试注册失败') })
  const log = t.mock.method(console, 'error', () => {})
  const world = await createWorldInitializationAgent()
  try {
    assert.equal(world.context.tools.get('skill'), undefined)
    assert.equal(world.context.tools.get('read_file'), undefined)
    assert.deepEqual(await world.run({ prompt: '构想' }), { content: '完成' })
    assert.equal(adapter.requests[0]?.tools, undefined)
    assert.doesNotMatch(JSON.stringify(adapter.requests[0]?.messages), /<available_skills>/)
    const messages = log.mock.calls.map(call => String(call.arguments[0]))
    assert.ok(messages.some(message => message.includes('skill')))
    assert.ok(messages.some(message => message.includes('read_file')))
  } finally {
    await world.dispose()
  }
})

test('一个工具注册失败不会影响已成功注册的其他工具', async (t) => {
  const adapter = new Adapter()
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'test', adapter }))
  const register = ToolsService.prototype.register
  t.mock.method(ToolsService.prototype, 'register', function (this: ToolsService, tool: ToolDefinition) {
    if (tool.name === 'read_file') throw new Error('测试注册失败')
    return register.call(this, tool)
  })
  const log = t.mock.method(console, 'error', () => {})
  const world = await createWorldInitializationAgent()
  try {
    assert.ok(world.context.tools.get('skill'))
    assert.equal(world.context.tools.get('read_file'), undefined)
    assert.equal(log.mock.calls.length, 1)
    assert.match(String(log.mock.calls[0]?.arguments[0]), /read_file/)
    assert.deepEqual(await world.run({ prompt: '构想' }), { content: '完成' })
    assert.deepEqual(adapter.requests[0]?.tools?.map(tool => tool.name), ['skill'])
  } finally {
    await world.dispose()
  }
})
