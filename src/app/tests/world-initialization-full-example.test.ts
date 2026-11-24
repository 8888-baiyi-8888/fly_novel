import assert from 'node:assert/strict'
import { readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { LlmAdapter, type GenerateOptions, type StreamChunk, type ToolCallId } from '@fly-novel/llm'
import configured = require('../call-llm.js')
import { runWorldInitializationFullExample, sampleInput } from '../world-initialization-full-example.js'

class ScriptedModel extends LlmAdapter {
  private step = 0
  constructor(private readonly discussion: boolean) { super() }
  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (this.step++ === 0) {
      const name = this.discussion ? 'discussion_prepare' : 'save_first_world_plan'
      const args = this.discussion ? { content: '# 城邦世界\n夜间关闭城门，紧急医疗运输可以申请通行。', summary: '修改城门规则' }
        : { content: '# 城邦世界\n曲水城夜间关闭城门，外海留白。' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'sample' as ToolCallId, name, arguments: JSON.stringify(args) } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '结果已保存。' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

test('真实模型样例的分步流程使用模拟确认、保存候选并交付', { timeout: 30000 }, async t => {
  let calls = 0
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'fixed', adapter: new ScriptedModel(calls++ >= 2) }))
  const output: string[] = []
  const result = await runWorldInitializationFullExample(sampleInput, text => output.push(text))
  t.after(() => rm(result.root, { recursive: true, force: true }))
  assert.equal(calls, 3)
  assert.ok(output.some(line => line.includes('模拟用户确认')))
  assert.ok(output.some(line => line.includes('主 Agent 第 1 步开始')))
  assert.ok(output.some(line => line.includes('开始调用工具 save_first_world_plan')))
  assert.ok(output.some(line => line.includes('工具 save_first_world_plan已返回：调用未报错')))
  assert.ok(output.some(line => line.includes('开始调用工具 discussion_prepare')))
  assert.ok(output.some(line => line.includes('空发现不代表不存在冲突')))
  const delivery: unknown = JSON.parse(await readFile(join(result.root, 'delivery', 'deliveries', `${result.deliveryId}.json`), 'utf8'))
  assert.ok(delivery && typeof delivery === 'object' && 'worldId' in delivery && delivery.worldId === result.worldId)
  const plans = await readdir(join(result.root, 'world', 'main'))
  assert.equal(plans.length, 1)
  assert.match(await readFile(join(result.root, 'world', 'main', plans[0]!), 'utf8'), /医疗运输/)
})

test('示例确认字符串不匹配时不会进入讨论或交付', { timeout: 30000 }, async t => {
  let calls = 0
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'fixed', adapter: new ScriptedModel(calls++ >= 2) }))
  const output: string[] = []
  await assert.rejects(runWorldInitializationFullExample({ ...sampleInput, firstVersionDecision: '还没确认' }, text => output.push(text)), /未确认第一版/)
  const root = output.find(line => line.startsWith('样例目录：'))?.slice('样例目录：'.length)
  assert.ok(root)
  t.after(() => rm(root, { recursive: true, force: true }))
  assert.deepEqual(await readdir(join(root, 'discussion', 'discussions')), [])
  assert.deepEqual(await readdir(join(root, 'delivery', 'deliveries')), [])
})

test('候选审阅字符串不匹配时保留候选且不改写正文', { timeout: 30000 }, async t => {
  let calls = 0
  t.mock.method(configured, 'loadConfiguredAdapter', async (provider: string) => ({ provider, model: 'fixed', adapter: new ScriptedModel(calls++ >= 2) }))
  const output: string[] = []
  await assert.rejects(runWorldInitializationFullExample({ ...sampleInput, reviewDecision: '暂不确认' }, text => output.push(text)), /未确认候选/)
  const root = output.find(line => line.startsWith('样例目录：'))?.slice('样例目录：'.length)
  assert.ok(root)
  t.after(() => rm(root, { recursive: true, force: true }))
  const candidates = await readdir(join(root, 'discussion', 'candidates'))
  assert.equal(candidates.length, 1)
  const plans = await readdir(join(root, 'world', 'main'))
  const original = await readFile(join(root, 'world', 'main', plans[0]!), 'utf8')
  assert.doesNotMatch(original, /紧急医疗运输可以申请通行/)
  assert.deepEqual(await readdir(join(root, 'delivery', 'deliveries')), [])
})
