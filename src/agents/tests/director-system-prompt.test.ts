import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@fly-novel/llm'
import { bootstrapAgents } from '@fly-novel/agents'

class FixedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '渡船即将离岸。' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

test('导演 Preset 注册提示词，角色隔离并随 Agent 销毁', async (t) => {
  const framework = await bootstrapAgents()
  t.after(() => framework.manager.disposeAll())
  const adapter = new FixedAdapter()
  const pluginConfigs = {
    'agent-loop-runtime': { provider: 'test', model: 'test' },
    llm: { adapters: [{ providers: ['test'], adapter }] },
  }
  const director = await framework.manager.create({ id: 'director', presetId: 'director-agent', pluginConfigs })
  const character = await framework.manager.create({ id: 'character', presetId: 'character-agent', pluginConfigs })
  const directorPrompt = director.context.systemPrompt
  const characterPrompt = character.context.systemPrompt
  assert.notEqual(directorPrompt, characterPrompt)
  assert.equal(directorPrompt.getSection('character:identity'), undefined)
  assert.equal(characterPrompt.getSection('director:identity'), undefined)

  assert.deepEqual(await director.run({ prompt: '设计渡船即将离岸时两位人物面临的处境。' }), { content: '渡船即将离岸。' })
  const system = adapter.requests[0]?.messages.find(message => message.role === 'system')
  assert.equal(system?.content?.[0]?.type, 'text')
  const prompt = JSON.stringify(system?.content)
  assert.match(prompt, /父故事.*子故事数量.*初步安排/)
  assert.match(prompt, /后续子故事根据实际结果逐个完善/)
  assert.match(prompt, /不指定角色的决定或内心变化/)
  assert.match(prompt, /区分已发生的事实、发展方向和尚未确定的内容/)
  assert.match(prompt, /资料不足时说明缺口/)
  assert.match(prompt, /不声称已经读取资料、调用角色或完成未实际执行的工作/)
  await framework.manager.dispose('director')
  assert.throws(() => directorPrompt.assemble(), /已销毁/)
  assert.ok(characterPrompt.getSection('character:identity'))
})
