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
  assert.deepEqual(system?.content, [{ type: 'text', text: '你是一个小说导演 Agent。请根据提供的创作目标、世界规则和人物状态安排事件与处境，为人物留下自主选择的空间，不指定人物的决定或内心变化。' }])
  await framework.manager.dispose('director')
  assert.throws(() => directorPrompt.assemble(), /已销毁/)
  assert.ok(characterPrompt.getSection('character:identity'))
})
