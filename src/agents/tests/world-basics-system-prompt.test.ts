import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@fly-novel/llm'
import { bootstrapAgents } from '../core/bootstrap.js'
import { createTestAgent } from './agent-loop-fixtures.js'

class CaptureAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '建议已整理' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

test('世界基础信息 Preset 将职责注入模型请求并随作用域清理', async t => {
  const framework = await bootstrapAgents()
  t.after(() => framework.manager.disposeAll())
  const adapter = new CaptureAdapter()
  const agent = await createTestAgent(framework, { id: 'basics', presetId: 'world-basics', pluginConfigs: {
    llm: { adapters: [{ providers: ['test-provider'], adapter }] },
  } })
  for (const prompt of ['开放式修仙世界，力量无善恶', '资源有限的城邦群，外海留白']) await agent.run({ prompt })
  assert.equal(adapter.requests.length, 2)
  for (const request of adapter.requests) {
    const system = JSON.stringify(request.messages.find(message => message.role === 'system'))
    assert.match(system, /世界基础信息 Agent/)
    assert.match(system, /区分用户明确要求、已有资料、你的补充建议/)
    assert.match(system, /用户明确留白的内容保留留白/)
    assert.match(system, /不直接修改其他负责人或已确认资料/)
    assert.match(system, /不代表用户确认世界事实/)
  }
  const service = agent.context.systemPrompt
  await framework.manager.dispose('basics')
  assert.throws(() => service.assemble(), /已销毁/)
})
