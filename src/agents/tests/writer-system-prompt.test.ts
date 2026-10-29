import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@fly-novel/llm'
import { bootstrapAgents } from '@fly-novel/agents'
import { systemPrompt } from '../writer/system-prompt.js'

class FixedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '渡船缓缓离岸。' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

test('写作 Preset 使用完整写作提示词并与角色和导演隔离', async (t) => {
  const framework = await bootstrapAgents()
  t.after(() => framework.manager.disposeAll())
  const adapter = new FixedAdapter()
  const pluginConfigs = {
    'agent-loop-runtime': { provider: 'test', model: 'test' },
    llm: { adapters: [{ providers: ['test'], adapter }] },
  }
  const writer = await framework.manager.create({ id: 'writer', presetId: 'writer-agent', pluginConfigs })
  const character = await framework.manager.create({ id: 'character', presetId: 'character-agent', pluginConfigs })
  const director = await framework.manager.create({ id: 'director', presetId: 'director-agent', pluginConfigs })
  const prompt = writer.context.systemPrompt
  assert.equal(writer.info.identity.role, 'writer')
  assert.equal(prompt.getSection('character:identity'), undefined)
  assert.equal(prompt.getSection('director:identity'), undefined)
  assert.equal(character.context.systemPrompt.getSection('writer:identity'), undefined)
  assert.equal(director.context.systemPrompt.getSection('writer:identity'), undefined)
  assert.deepEqual(await writer.run({ prompt: '根据已确认的事件撰写渡船离岸的正文。' }), { content: '渡船缓缓离岸。' })
  const system = adapter.requests[0]?.messages.find(message => message.role === 'system')
  assert.deepEqual(system?.content, [{ type: 'text', text: systemPrompt }])
  await framework.manager.dispose('writer')
  assert.throws(() => prompt.assemble(), /已销毁/)
  assert.ok(character.context.systemPrompt.getSection('character:identity'))
  assert.ok(director.context.systemPrompt.getSection('director:identity'))
})
