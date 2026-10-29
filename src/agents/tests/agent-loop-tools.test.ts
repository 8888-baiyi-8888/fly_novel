import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { test } from 'node:test'
import { LlmAdapter, type GenerateOptions, type StreamChunk, type ToolCallId } from '@fly-novel/llm'
import { bootstrapAgents } from '@fly-novel/agents'
import type { ToolDefinition, ToolRunContext } from '@fly-novel/tools'
import { readFileTool } from '../../tools/filesystem/read-file.js'

class ToolCallAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly name = 'read_file', private readonly count = 1, private readonly callId = 'call-1') { super() }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.requests.length === 1) {
      const block = { type: 'tool-call' as const, id: this.callId as ToolCallId, name: this.name, arguments: '{"path":"outline.txt"}' }
      yield { type: 'block-end', index: 0, block }
      if (this.count === 2) yield { type: 'block-end', index: 1, block: { ...block, id: 'call-2' as ToolCallId } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '提纲总结' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

test('Agent Loop 使用真实 read_file 完成两次模型请求', async (t) => {
  const workingDirectory = await mkdtemp(join(tmpdir(), 'fly-novel-loop-tools-'))
  t.after(() => rm(workingDirectory, { recursive: true, force: true }))
  await writeFile(join(workingDirectory, 'outline.txt'), '第一章：启程', 'utf8')
  const framework = await bootstrapAgents()
  t.after(() => framework.manager.disposeAll())
  const adapter = new ToolCallAdapter()
  framework.presets.register({ id: 'loop-tools', version: '1', role: 'character', plugins: [
    { pluginId: 'agent-loop-runtime', config: { provider: 'test', model: 'test', workingDirectory } },
    { pluginId: 'session' }, { pluginId: 'system-prompt' }, { pluginId: 'llm' }, { pluginId: 'tools' },
  ] })
  const agent = await framework.manager.create({ id: 'loop-tools', presetId: 'loop-tools',
    pluginConfigs: { llm: { adapters: [{ providers: ['test'], adapter }] } } })
  agent.context.tools.register(readFileTool)
  assert.deepEqual(await agent.run({ prompt: '读取提纲并总结' }), { content: '提纲总结' })
  assert.equal(adapter.requests.length, 2)
  assert.equal(adapter.requests[0]?.tools?.[0]?.name, 'read_file')
  const history = adapter.requests[1]?.messages
  assert.ok(history)
  assert.deepEqual(history.map(message => message.role), ['user', 'assistant', 'user'])
  assert.deepEqual(history[1]?.content, [{ type: 'tool-call', id: 'call-1', name: 'read_file', arguments: '{"path":"outline.txt"}' }])
  assert.deepEqual(history[2]?.content, [{ type: 'tool-result', toolCallId: 'call-1', isError: false,
    content: [{ type: 'text', text: '第一章：启程' }] }])
  const session = agent.context.sessions.list()[0]
  assert.ok(session)
  assert.deepEqual(session.read().map(event => event.type), [
    'turn/start', 'step/start', 'user/message', 'assistant/message', 'tool/call', 'tool/result', 'step/end',
    'step/start', 'assistant/message', 'step/end', 'turn/end',
  ])
})

test('不同 Agent 共用工具定义时保留身份、调用 ID 和授权目录隔离', async (t) => {
  const rootA = await mkdtemp(join(tmpdir(), 'fly-novel-agent-a-'))
  const rootB = await mkdtemp(join(tmpdir(), 'fly-novel-agent-b-'))
  t.after(async () => { await rm(rootA, { recursive: true, force: true }); await rm(rootB, { recursive: true, force: true }) })
  await writeFile(join(rootA, 'outline.txt'), 'Agent A', 'utf8')
  await writeFile(join(rootB, 'outline.txt'), 'Agent B', 'utf8')
  const framework = await bootstrapAgents()
  t.after(() => framework.manager.disposeAll())
  framework.presets.register({ id: 'tool-isolation', version: '1', role: 'character', plugins: [
    { pluginId: 'agent-loop-runtime' }, { pluginId: 'session' }, { pluginId: 'system-prompt' },
    { pluginId: 'llm' }, { pluginId: 'tools' },
  ] })
  const observed: ToolRunContext[] = []
  const shared: ToolDefinition = {
    ...readFileTool,
    execute(args, exec) { observed.push(exec); return readFileTool.execute(args, exec) },
  }
  const adapterA = new ToolCallAdapter('read_file', 1, 'call-a')
  const adapterB = new ToolCallAdapter('read_file', 1, 'call-b')
  const agentA = await framework.manager.create({ id: 'agent-a', presetId: 'tool-isolation', pluginConfigs: {
    'agent-loop-runtime': { provider: 'test', model: 'test', workingDirectory: rootA },
    llm: { adapters: [{ providers: ['test'], adapter: adapterA }] },
  } })
  const agentB = await framework.manager.create({ id: 'agent-b', presetId: 'tool-isolation', pluginConfigs: {
    'agent-loop-runtime': { provider: 'test', model: 'test', workingDirectory: rootB },
    llm: { adapters: [{ providers: ['test'], adapter: adapterB }] },
  } })
  agentA.context.tools.register(shared)
  agentB.context.tools.register(shared)
  await Promise.all([agentA.run({ prompt: '读取' }), agentB.run({ prompt: '读取' })])
  assert.deepEqual(observed.map(exec => ({ id: exec.agent?.id, callId: exec.callId, name: exec.name, root: exec.workingDirectory }))
    .sort((a, b) => a.id!.localeCompare(b.id!)), [
    { id: 'agent-a', callId: 'call-a', name: 'read_file', root: rootA },
    { id: 'agent-b', callId: 'call-b', name: 'read_file', root: rootB },
  ])
  assert.ok(observed.every(exec => exec.signal instanceof AbortSignal))
  const contentA = adapterA.requests[1]?.messages.at(-1)?.content[0]
  const contentB = adapterB.requests[1]?.messages.at(-1)?.content[0]
  assert.ok(contentA?.type === 'tool-result' && contentB?.type === 'tool-result')
  assert.deepEqual(contentA.content, [{ type: 'text', text: 'Agent A' }])
  assert.deepEqual(contentB.content, [{ type: 'text', text: 'Agent B' }])
  const outside = relative(rootA, join(rootB, 'outline.txt'))
  const attempt = await agentA.context.tools.execute({
    calls: [{ type: 'tool-call', id: 'escape-a' as ToolCallId, name: 'read_file', arguments: JSON.stringify({ path: outside }) }],
    signal: new AbortController().signal, workingDirectory: rootA,
  })
  const denied = attempt.results[0]?.result
  assert.ok(denied?.isError)
  assert.match(denied.error.message, /超出授权工作目录/)
})

test('未知工具的错误结果关联调用并传给下一次模型请求', async (t) => {
  const framework = await bootstrapAgents()
  t.after(() => framework.manager.disposeAll())
  const adapter = new ToolCallAdapter('missing')
  framework.presets.register({ id: 'tool-error', version: '1', role: 'character', plugins: [
    { pluginId: 'agent-loop-runtime', config: { provider: 'test', model: 'test', workingDirectory: '.' } },
    { pluginId: 'session' }, { pluginId: 'system-prompt' }, { pluginId: 'llm' }, { pluginId: 'tools' },
  ] })
  const agent = await framework.manager.create({ id: 'tool-error', presetId: 'tool-error',
    pluginConfigs: { llm: { adapters: [{ providers: ['test'], adapter }] } } })
  assert.deepEqual(await agent.run({ prompt: '测试' }), { content: '提纲总结' })
  const block = adapter.requests[1]?.messages.at(-1)?.content[0]
  assert.ok(block?.type === 'tool-result')
  assert.equal(block.toolCallId, 'call-1')
  assert.equal(block.isError, true)
})

test('单个 Step 拒绝多个工具调用', async (t) => {
  const framework = await bootstrapAgents()
  t.after(() => framework.manager.disposeAll())
  const adapter = new ToolCallAdapter('read_file', 2)
  framework.presets.register({ id: 'tool-multiple', version: '1', role: 'character', plugins: [
    { pluginId: 'agent-loop-runtime', config: { provider: 'test', model: 'test', workingDirectory: '.' } },
    { pluginId: 'session' }, { pluginId: 'system-prompt' }, { pluginId: 'llm' }, { pluginId: 'tools' },
  ] })
  const agent = await framework.manager.create({ id: 'tool-multiple', presetId: 'tool-multiple',
    pluginConfigs: { llm: { adapters: [{ providers: ['test'], adapter }] } } })
  await assert.rejects(agent.run({ prompt: '测试' }), { code: 'UNSUPPORTED_TOOL_CALLS' })
  assert.equal(adapter.requests.length, 1)
})

test('有可见工具但没有授权目录时不发送模型请求', async (t) => {
  const framework = await bootstrapAgents()
  t.after(() => framework.manager.disposeAll())
  const adapter = new ToolCallAdapter()
  framework.presets.register({ id: 'tool-no-dir', version: '1', role: 'character', plugins: [
    { pluginId: 'agent-loop-runtime', config: { provider: 'test', model: 'test' } },
    { pluginId: 'session' }, { pluginId: 'system-prompt' }, { pluginId: 'llm' }, { pluginId: 'tools' },
  ] })
  const agent = await framework.manager.create({ id: 'tool-no-dir', presetId: 'tool-no-dir',
    pluginConfigs: { llm: { adapters: [{ providers: ['test'], adapter }] } } })
  agent.context.tools.register(readFileTool)
  await assert.rejects(agent.run({ prompt: '测试' }), /需要配置授权工作目录/)
  assert.equal(adapter.requests.length, 0)
})
