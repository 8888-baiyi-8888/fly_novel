import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { LlmAdapter, type GenerateOptions, type StreamChunk, type ToolCallId } from '@fly-novel/llm'
import configured = require('../call-llm.js')
import { createWorldInitializationAgentWithWorkspace } from '../agents/index.js'
import { prepareFileDebugWorkspace, runFileDebugSession } from '../world-initialization-files-debug.js'

class Adapter extends LlmAdapter {
  count = 0
  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.count++
    if (this.count === 1) {
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'write' as ToolCallId, name: 'write', arguments: '{"file_path":"draft/test.txt","content":"测试内容"}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '已创建' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

test('调试入口保留已有文件并显示真实工具链的调用状态', async t => {
  await mkdir('tmp', { recursive: true })
  const base = await mkdtemp(join(process.cwd(), 'tmp', 'fly-files-debug-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const roots = await prepareFileDebugWorkspace(base)
  const existing = join(roots.confirmedRoot, 'fact.txt')
  await writeFile(existing, '原有资料')
  await prepareFileDebugWorkspace(base)
  assert.equal(await readFile(existing, 'utf8'), '原有资料')
  const adapter = new Adapter()
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'test', adapter }))
  const agent = await createWorldInitializationAgentWithWorkspace(roots)
  const output: string[] = []
  async function* input() { yield '创建草稿'; yield '/exit'; yield '不应执行' }
  try { await runFileDebugSession(agent, input(), line => output.push(line)) }
  finally { await agent.dispose() }
  assert.equal(await readFile(join(roots.draftRoot, 'test.txt'), 'utf8'), '测试内容')
  assert.ok(output.some(line => line.startsWith('工具> write ')))
  assert.ok(output.includes('工具结果> 成功'))
  assert.ok(output.includes('Agent> 已创建'))
  assert.equal(adapter.count, 2)
})
