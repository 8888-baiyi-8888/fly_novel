import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { LlmAdapter, type GenerateOptions, type StreamChunk, type ToolCallId } from '@fly-novel/llm'
import configured = require('../call-llm.js')
import { createWorldInitializationAgentWithWorkspace } from '../agents/index.js'
import { AgentManager, type Agent } from '@fly-novel/agents'

class WorldFilesAdapter extends LlmAdapter {
  readonly parentRequests: GenerateOptions[] = []
  readonly childRequests: GenerateOptions[] = []
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const parent = options.tools?.some(tool => tool.name === 'delegate') === true
    const requests = parent ? this.parentRequests : this.childRequests
    requests.push(options)
    const calls = parent ? [
      { name: 'glob', args: { pattern: '*.txt' } },
      { name: 'grep', args: { pattern: 'confirmed' } },
      { name: 'read', args: { file_path: 'confirmed/fact.txt' } },
      { name: 'write', args: { file_path: 'confirmed/fact.txt', content: 'bad' } },
      { name: 'write', args: { file_path: 'draft/idea.txt', content: 'before' } },
      { name: 'read', args: { file_path: 'draft/idea.txt' } },
      { name: 'edit', args: { file_path: 'draft/idea.txt', old_string: 'before', new_string: 'after' } },
      { name: 'apply_patch', args: { input: '*** Begin Patch\n*** Delete File: draft/idea.txt\n*** End Patch' } },
      { name: 'delegate', args: { task: '读取已确认资料并检查权限' } },
    ] : [
      { name: 'read', args: { file_path: 'confirmed/fact.txt' } },
      { name: 'grep', args: { pattern: 'confirmed' } },
      { name: 'write', args: { file_path: 'confirmed/fact.txt', content: 'bad' } },
      { name: 'write', args: { file_path: 'draft/child.txt', content: 'bad' } },
    ]
    const next = calls[requests.length - 1]
    if (next) {
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `${parent ? 'p' : 'c'}-${requests.length}` as ToolCallId, name: next.name, arguments: JSON.stringify(next.args) } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-end', index: 0, block: { type: 'text', text: parent ? '主任务完成' : '子任务完成' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

test('真实主子 Agent 搜索、修改草稿并保护已确认资料', async t => {
  const parent = join(process.cwd(), 'tmp'); await mkdir(parent, { recursive: true })
  const raw = await mkdtemp(join(parent, 'fly-world-e2e-'))
  t.after(() => rm(raw, { recursive: true, force: true }))
  const viewRoot = await realpath(raw); const draftRoot = join(viewRoot, 'draft'); const confirmedRoot = join(viewRoot, 'confirmed')
  await mkdir(draftRoot); await mkdir(confirmedRoot)
  const fact = join(confirmedRoot, 'fact.txt'); await writeFile(fact, 'confirmed fact\n')
  const adapter = new WorldFilesAdapter()
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'test', adapter }))
  const agent = await createWorldInitializationAgentWithWorkspace({ viewRoot, draftRoot, confirmedRoot })
  try {
    assert.deepEqual(await agent.run({ prompt: '检查并修改草稿' }), { content: '主任务完成' })
    const results = agent.context.sessions.list()[0]!.read().filter(event => event.type === 'tool/result')
    assert.equal(results.length, 9)
    assert.equal(results[3]!.data.error?.code, 'FS_SANDBOX_DENIED')
    for (const [index, result] of results.entries()) if (index !== 3) assert.equal(result.data.error, undefined, `主调用 ${index}`)
    assert.equal(await readFile(fact, 'utf8'), 'confirmed fact\n')
    await assert.rejects(readFile(join(draftRoot, 'idea.txt')))
    await assert.rejects(readFile(join(draftRoot, 'child.txt')))
    assert.equal(adapter.childRequests.length, 5)
    assert.ok(adapter.childRequests[0]?.tools?.some(tool => tool.name === 'read'))
    assert.ok(!adapter.childRequests[0]?.tools?.some(tool => tool.name === 'write'))
    const childHistory = JSON.stringify(adapter.childRequests.at(-1)?.messages)
    assert.match(childHistory, /confirmed fact/)
    assert.doesNotMatch(childHistory, /主任务完成/)
    const childResults = adapter.childRequests.at(-1)!.messages.flatMap(message => message.content).filter(block => block.type === 'tool-result')
    assert.equal(childResults.length, 4)
    assert.deepEqual(childResults.map(result => result.isError), [false, false, true, true])
  } finally { await agent.dispose() }
})

test('受控入口的子任务失败和取消后释放子 Agent', { timeout: 10000 }, async t => {
  const parent = join(process.cwd(), 'tmp'); await mkdir(parent, { recursive: true })
  const raw = await mkdtemp(join(parent, 'fly-world-cancel-'))
  t.after(() => rm(raw, { recursive: true, force: true }))
  const viewRoot = await realpath(raw); const draftRoot = join(viewRoot, 'draft'); const confirmedRoot = join(viewRoot, 'confirmed')
  await mkdir(draftRoot); await mkdir(confirmedRoot)
  let mode: 'fail' | 'wait' = 'fail'
  let started!: () => void
  const entered = new Promise<void>(resolve => { started = resolve })
  class ChildAdapter extends LlmAdapter {
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      if (mode === 'fail') {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: '模拟失败', code: 'PROVIDER_ERROR' } } }
        return
      }
      const signal = options.signal
      if (!signal) throw new Error('缺少取消信号')
      started()
      if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      yield { type: 'finish', reason: { kind: 'aborted', failure: { message: '取消', code: 'ABORTED' } } }
    }
  }
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'test', adapter: new ChildAdapter() }))
  const disposed: Agent[] = []
  const originalDispose = AgentManager.prototype.dispose
  t.mock.method(AgentManager.prototype, 'dispose', async function (this: AgentManager, id: string) {
    const child = this.get(id)
    await originalDispose.call(this, id)
    disposed.push(child)
  })
  const agent = await createWorldInitializationAgentWithWorkspace({ viewRoot, draftRoot, confirmedRoot })
  try {
    const call = (signal: AbortSignal) => agent.context.tools.execute({ calls: [{ type: 'tool-call', id: 'delegate' as ToolCallId, name: 'delegate', arguments: '{"task":"检查"}' }], workingDirectory: viewRoot, session: agent.context.sessions.list()[0]!, signal })
    assert.equal((await call(new AbortController().signal)).results[0]!.result.isError, true)
    assert.equal(disposed.length, 1)
    assert.equal(disposed[0]!.state, 'disposed')
    mode = 'wait'
    const controller = new AbortController()
    const pending = call(controller.signal)
    await entered
    controller.abort()
    assert.equal((await pending).results[0]!.result.isError, true)
    assert.equal(disposed.length, 2)
    assert.equal(disposed[1]!.state, 'disposed')
  } finally { await agent.dispose() }
})
