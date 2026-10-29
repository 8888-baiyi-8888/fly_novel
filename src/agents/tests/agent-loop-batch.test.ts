import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { LlmAdapter, type GenerateOptions, type StreamChunk, type ToolCallId } from '@fly-novel/llm'
import { bootstrapAgents } from '@fly-novel/agents'
import type { SessionEventMap, SessionEventType } from '@fly-novel/session'
import { readFileTool } from '../../tools/filesystem/read-file.js'

class BatchAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly repeat: boolean, private readonly includeMissing = false) { super() }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.requests.length === 1 || this.repeat) {
      const calls = [
        { id: 'call-1', name: 'read_file', arguments: '{"path":"a.txt"}' },
        ...(this.includeMissing ? [{ id: 'call-2', name: 'missing', arguments: '{}' }] : []),
        { id: 'call-3', name: 'read_file', arguments: '{"path":"b.txt"}' },
      ]
      for (const [index, call] of calls.entries()) {
        yield { type: 'block-end', index, block: { type: 'tool-call', ...call, id: call.id as ToolCallId } }
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '完成' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

async function setup(t: TestContext, adapter: BatchAdapter, maxSteps?: number) {
  const workingDirectory = await mkdtemp(join(tmpdir(), 'fly-novel-batch-'))
  t.after(() => rm(workingDirectory, { recursive: true, force: true }))
  await writeFile(join(workingDirectory, 'a.txt'), '文件 A', 'utf8')
  await writeFile(join(workingDirectory, 'b.txt'), '文件 B', 'utf8')
  const framework = await bootstrapAgents()
  t.after(() => framework.manager.disposeAll())
  framework.presets.register({ id: 'batch', version: '1', role: 'character', plugins: [
    { pluginId: 'agent-loop-runtime', config: { provider: 'test', model: 'test', workingDirectory, ...(maxSteps === undefined ? {} : { maxSteps }) } },
    { pluginId: 'session' }, { pluginId: 'system-prompt' }, { pluginId: 'llm' }, { pluginId: 'tools' },
  ] })
  const agent = await framework.manager.create({ id: 'batch', presetId: 'batch',
    pluginConfigs: { llm: { adapters: [{ providers: ['test'], adapter }] } } })
  const session = agent.context.sessions.list()[0]
  assert.ok(session)
  return { agent, session }
}

test('多工具串行执行，失败不阻止后续真实文件工具', async (t) => {
  const adapter = new BatchAdapter(false, true)
  const { agent, session } = await setup(t, adapter)
  const order: string[] = []
  agent.context.tools.register({ ...readFileTool, async execute(args, exec) {
    order.push(exec.callId)
    return readFileTool.execute(args, exec)
  } })
  assert.deepEqual(await agent.run({ prompt: '读取两个文件' }), { content: '完成' })
  assert.deepEqual(order, ['call-1', 'call-3'])
  const results = session.read().filter(event => event.type === 'tool/result')
  assert.deepEqual(results.map(event => event.data.message.source.callId), ['call-1', 'call-2', 'call-3'])
  assert.equal(results[1]?.data.error?.code, 'UNKNOWN_TOOL')
  const blocks = adapter.requests[1]?.messages.slice(-3).map(message => message.content[0])
  assert.deepEqual(blocks?.map(block => block?.type === 'tool-result' ? block.toolCallId : undefined), ['call-1', 'call-2', 'call-3'])
  assert.deepEqual(blocks?.[2]?.type === 'tool-result' ? blocks[2].content : undefined, [{ type: 'text', text: '文件 B' }])
})

test('工具函数抛错后仍执行下一项工具', async (t) => {
  const adapter = new BatchAdapter(false)
  const { agent, session } = await setup(t, adapter)
  agent.context.tools.register({ ...readFileTool, async execute(args, exec) {
    if (exec.callId === 'call-1') throw new Error('读取失败')
    return readFileTool.execute(args, exec)
  } })
  assert.deepEqual(await agent.run({ prompt: '读取两个文件' }), { content: '完成' })
  const results = session.read().filter(event => event.type === 'tool/result')
  assert.deepEqual(results.map(event => event.data.message.source.callId), ['call-1', 'call-3'])
  assert.equal(results[0]?.data.error?.code, 'TOOL_ERROR')
  assert.deepEqual(results[1]?.data.message.content[0].content, [{ type: 'text', text: '文件 B' }])
})

test('批次中取消等待活动工具结束，为未开始调用记录取消结果', async (t) => {
  const adapter = new BatchAdapter(false, true)
  const { agent, session } = await setup(t, adapter)
  let notify: () => void = () => undefined
  const started = new Promise<void>(resolve => { notify = resolve })
  const executed: string[] = []
  agent.context.tools.register({ ...readFileTool, async execute(_args, exec) {
    executed.push(exec.callId)
    notify()
    await new Promise<void>(resolve => exec.signal.addEventListener('abort', () => resolve(), { once: true }))
    return '已结束'
  } })
  const pending = agent.run({ prompt: '读取' })
  await started
  agent.cancel()
  await assert.rejects(pending, { code: 'ABORTED' })
  assert.deepEqual(executed, ['call-1'])
  const events = session.read()
  assert.deepEqual(events.filter(event => event.type === 'tool/call').map(event => event.data.callId), ['call-1'])
  const results = events.filter(event => event.type === 'tool/result')
  assert.deepEqual(results.map(event => event.data.message.source.callId), ['call-1', 'call-2', 'call-3'])
  assert.deepEqual(results.map(event => event.data.error?.code), ['ABORTED', 'ABORTED_BEFORE_DISPATCH', 'ABORTED_BEFORE_DISPATCH'])
  assert.doesNotThrow(() => session.deriveMessages())
  assert.equal(adapter.requests.length, 1)
})

test('达到最大 Step 数后完成当前批次并结束 Turn', async (t) => {
  const adapter = new BatchAdapter(true)
  const { agent, session } = await setup(t, adapter, 2)
  agent.context.tools.register(readFileTool)
  await assert.rejects(agent.run({ prompt: '读取' }), { code: 'MAX_STEPS' })
  assert.equal(adapter.requests.length, 2)
  const events = session.read()
  assert.equal(events.filter(event => event.type === 'tool/result').length, 4)
  assert.deepEqual(events.filter(event => event.type === 'turn/end')[0]?.data.reason, { kind: 'max-steps', maxSteps: 2 })
  assert.doesNotThrow(() => session.deriveMessages())
})

test('最后允许的 Step 返回最终文本时正常完成', async (t) => {
  const adapter = new BatchAdapter(false)
  const { agent } = await setup(t, adapter, 2)
  agent.context.tools.register(readFileTool)
  assert.deepEqual(await agent.run({ prompt: '读取' }), { content: '完成' })
  assert.equal(adapter.requests.length, 2)
})

test('未配置上限时默认执行最多 10 个 Step', async (t) => {
  const adapter = new BatchAdapter(true)
  const { agent, session } = await setup(t, adapter)
  agent.context.tools.register(readFileTool)
  await assert.rejects(agent.run({ prompt: '读取' }), { code: 'MAX_STEPS' })
  assert.equal(adapter.requests.length, 10)
  assert.deepEqual(session.read().filter(event => event.type === 'turn/end')[0]?.data.reason, { kind: 'max-steps', maxSteps: 10 })
})

test('maxSteps 必须是正整数', async (t) => {
  await assert.rejects(setup(t, new BatchAdapter(false), 0), /maxSteps 必须是正整数/)
  await assert.rejects(setup(t, new BatchAdapter(false), 1.5), /maxSteps 必须是正整数/)
})

test('批次记录中断时只补齐尚未记录的调用结果', async (t) => {
  const adapter = new BatchAdapter(false, true)
  const { agent, session } = await setup(t, adapter)
  agent.context.tools.register(readFileTool)
  const append = session.append.bind(session)
  t.mock.method(session, 'append', <T extends SessionEventType>(type: T, data: SessionEventMap[T]) => {
    if (type === 'tool/call' && (data as SessionEventMap['tool/call']).callId === 'call-2') throw new Error('记录中断')
    return append(type, data)
  })
  await assert.rejects(agent.run({ prompt: '读取' }), /记录中断/)
  const results = session.read().filter(event => event.type === 'tool/result')
  assert.deepEqual(results.map(event => event.data.message.source.callId), ['call-1', 'call-2', 'call-3'])
  assert.deepEqual(results.map(event => event.data.error?.code), [undefined, 'TOOL_NOT_STARTED', 'TOOL_NOT_STARTED'])
  assert.doesNotThrow(() => session.deriveMessages())
})
