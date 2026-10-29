import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { LlmAdapter, type GenerateOptions, type StreamChunk, type ToolCallId } from '@fly-novel/llm'
import { bootstrapAgents, jsonlSessionPersistencePlugin } from '@fly-novel/agents'
import { readFileTool } from '../../tools/filesystem/read-file.js'

class FixedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.requests.length === 1) {
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-1' as ToolCallId, name: 'read_file', arguments: '{"path":"outline.txt"}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-end', index: 0, block: { type: 'text', text: this.requests.length === 2 ? '已读取' : '继续写作' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

test('真实文件工具结果经 JSONL 保存后在重建的 Agent 中恢复并继续运行', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fly-session-acceptance-'))
  const dispose: Array<() => Promise<void>> = []
  t.after(async () => {
    for (const close of dispose.reverse()) await close()
    await rm(directory, { recursive: true, force: true })
  })
  await writeFile(join(directory, 'outline.txt'), '第一章：启程', 'utf8')
  const adapter = new FixedAdapter()
  const setup = async (resume: boolean) => {
    const framework = await bootstrapAgents()
    const backend = framework.context.plugin(jsonlSessionPersistencePlugin, { root: join(directory, 'sessions') })
    await backend
    dispose.push(async () => { await framework.manager.disposeAll(); await backend.dispose() })
    framework.presets.register({ id: 'acceptance', version: '1', role: 'character', plugins: [
      { pluginId: 'agent-loop-runtime' }, { pluginId: 'session' }, { pluginId: 'system-prompt' },
      { pluginId: 'llm' }, { pluginId: 'tools' },
    ] })
    const agent = await framework.manager.create({ id: 'character', presetId: 'acceptance', pluginConfigs: {
      'agent-loop-runtime': { provider: 'test', model: 'test', workingDirectory: directory,
        ...(resume ? { resumeSessionId: 'session-1' } : { sessionId: 'session-1' }) },
      llm: { adapters: [{ providers: ['test'], adapter }] },
    } })
    agent.context.tools.register(readFileTool)
    return { framework, backend, agent }
  }
  const first = await setup(false)
  assert.deepEqual(await first.agent.run({ prompt: '读取提纲' }), { content: '已读取' })
  const session = first.agent.context.sessions.list()[0]
  assert.ok(session)
  await first.agent.context.sessions.flush(session)
  await first.framework.manager.disposeAll()
  await first.backend.dispose()
  await rm(join(directory, 'outline.txt'))

  const second = await setup(true)
  const restored = second.agent.context.sessions.list()[0]
  assert.equal(restored?.id, 'session-1')
  assert.deepEqual(await second.agent.run({ prompt: '继续' }), { content: '继续写作' })
  const messages = adapter.requests[2]?.messages
  assert.ok(messages)
  assert.deepEqual(messages.map(message => message.role), ['user', 'assistant', 'user', 'assistant', 'user'])
  assert.deepEqual(messages[0]?.content, [{ type: 'text', text: '读取提纲' }])
  assert.deepEqual(messages[1]?.content, [{ type: 'tool-call', id: 'call-1', name: 'read_file', arguments: '{"path":"outline.txt"}' }])
  assert.deepEqual(messages[2]?.content, [{ type: 'tool-result', toolCallId: 'call-1', isError: false,
    content: [{ type: 'text', text: '第一章：启程' }] }])
  assert.deepEqual(messages[3]?.content, [{ type: 'text', text: '已读取' }])
  assert.deepEqual(messages[4]?.content, [{ type: 'text', text: '继续' }])
  assert.deepEqual(restored?.read().filter(event => event.type === 'turn/start').map(event => event.data.turn), [1, 2])
})
