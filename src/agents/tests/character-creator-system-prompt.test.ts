import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@fly-novel/llm'
import { bootstrapAgents } from '../core/bootstrap.js'
import { createTestAgent, withAgentLoop } from './agent-loop-fixtures.js'

class CaptureAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '已处理' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

test('角色创建职责与配置进入模型请求并随作用域清理', async t => {
  const framework = await bootstrapAgents()
  t.after(() => framework.manager.disposeAll())
  framework.presets.register({ id: 'creator-prompt-test', version: '1', role: 'general', plugins: withAgentLoop([
    { pluginId: 'character-creator-system-prompt' },
  ]) })
  const adapter = new CaptureAdapter()
  const agent = await createTestAgent(framework, { id: 'creator', presetId: 'creator-prompt-test', pluginConfigs: {
    'character-creator-system-prompt': { defaultCharacterCount: 4 },
    llm: { adapters: [{ providers: ['test-provider'], adapter }] },
  } })
  const prompts = ['创建多名角色', '修改现有角色', '缺少世界资料', '明确创建两人']
  for (const prompt of prompts) await agent.run({ prompt })
  assert.equal(adapter.requests.length, prompts.length)
  for (const [index, request] of adapter.requests.entries()) {
    const system = JSON.stringify(request.messages.find(message => message.role === 'system'))
    assert.match(system, /角色设定创建 Agent/)
    assert.match(system, /默认生成 4 个角色/)
    assert.match(system, /用户明确指定数量或其他要求时优先遵循/)
    assert.match(system, /第二、第三梯队只创建近期故事需要的人物/)
    assert.match(system, /资料仍不足时向调用方说明/)
    assert.match(system, /不直接修改其他角色或世界资料/)
    assert.match(system, /不代表用户已确认/)
    assert.doesNotMatch(system, /角色扮演 Agent/)
    assert.match(JSON.stringify(request.messages), new RegExp(prompts[index]!))
  }
  const promptService = agent.context.systemPrompt
  await framework.manager.dispose('creator')
  assert.throws(() => promptService.assemble(), /已销毁/)
})

test('角色创建提示词拒绝缺失、非整数或非正数的默认数量', async t => {
  const framework = await bootstrapAgents()
  t.after(() => framework.manager.disposeAll())
  framework.presets.register({ id: 'creator-invalid-test', version: '1', role: 'general', plugins: withAgentLoop([
    { pluginId: 'character-creator-system-prompt' },
  ]) })
  for (const value of [undefined, 0, -1, 1.5]) {
    await assert.rejects(createTestAgent(framework, { id: 'invalid', presetId: 'creator-invalid-test', pluginConfigs: {
      'character-creator-system-prompt': value === undefined ? {} : { defaultCharacterCount: value },
    } }), /角色默认生成数量必须是正整数/)
  }
})
