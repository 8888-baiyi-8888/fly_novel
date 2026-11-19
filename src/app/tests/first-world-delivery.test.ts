import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { LlmAdapter, type GenerateOptions, type StreamChunk, type ToolCallId } from '@fly-novel/llm'
import configured = require('../call-llm.js')
import { createWorldInitializationAgentWithWorkspace } from '../agents/index.js'

test('第一版总览读取实际来源，区分候选局势、未来方向与留白', async t => {
  const tmp = join(process.cwd(), 'tmp'); await mkdir(tmp, { recursive: true })
  const root = await realpath(await mkdtemp(join(tmp, 'first-delivery-'))); t.after(() => rm(root, { recursive: true, force: true }))
  const viewRoot = join(root, 'world'); const draftRoot = join(viewRoot, 'draft'); const confirmedRoot = join(viewRoot, 'confirmed')
  await mkdir(draftRoot, { recursive: true }); await mkdir(confirmedRoot)
  await writeFile(join(confirmedRoot, 'background.md'), '用户要求：城邦面临缺水；远方保留未知。')
  await writeFile(join(confirmedRoot, 'alternatives.md'), '候选 A：上游封渠。候选 B：暂时通水。两者均未选用。')
  let planPath = ''
  class Planner extends LlmAdapter {
    private step = 0
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      const call = (id: string, name: string, args: object): StreamChunk => ({ type: 'block-end', index: 0, block: { type: 'tool-call', id: id as ToolCallId, name, arguments: JSON.stringify(args) } })
      const step = this.step++
      if (step === 0) yield call('background', 'read', { file_path: 'confirmed/background.md' })
      else if (step === 1) { assert.match(JSON.stringify(options.messages), /远方保留未知/); yield call('alternatives', 'read', { file_path: 'confirmed/alternatives.md' }) }
      else if (step === 2) {
        assert.match(JSON.stringify(options.messages), /上游封渠/); assert.match(JSON.stringify(options.messages), /暂时通水/)
        yield call('save', 'save_first_world_plan', { content: '用户要求：城邦缺水（confirmed/background.md）。候选 A：上游封渠；未来可能谈判。候选 B：暂时通水；未来可能协商。两项均待审，尚未选用（confirmed/alternatives.md）。远方未知，未检查其他地区。' })
      } else {
        const block = options.messages.flatMap(message => message.content).find(item => item.type === 'tool-result' && item.toolCallId === 'save')
        assert.ok(block && block.type === 'tool-result' && !block.isError)
        const text = block.content.find(item => item.type === 'text'); assert.ok(text && text.type === 'text')
        const saved: unknown = JSON.parse(text.text); assert.ok(saved && typeof saved === 'object' && 'path' in saved && typeof saved.path === 'string')
        planPath = saved.path
        yield { type: 'block-end', index: 0, block: { type: 'text', text: `待审总览：${planPath}` } }
        yield { type: 'finish', reason: { kind: 'stop' } }; return
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
  }
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'test', adapter: new Planner() }))
  const parent = await createWorldInitializationAgentWithWorkspace({ viewRoot, draftRoot, confirmedRoot })
  try {
    await parent.run({ prompt: '构想已确认，请整合已有资料。' })
    const plan = await readFile(join(viewRoot, planPath), 'utf8')
    assert.match(plan, /候选 A：上游封渠/); assert.match(plan, /候选 B：暂时通水/)
    assert.match(plan, /尚未选用/); assert.match(plan, /远方未知/); assert.match(plan, /confirmed\/alternatives\.md/)
    assert.match(await readFile(join(confirmedRoot, 'alternatives.md'), 'utf8'), /两者均未选用/)
  } finally { await parent.dispose() }
})
