import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@fly-novel/llm'
import { bootstrapAgents } from '@fly-novel/agents'

class FixedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '角色回应' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

test('角色 Preset 注册提示词，实例隔离并随 Agent 销毁', async (t) => {
  const framework = await bootstrapAgents()
  t.after(() => framework.manager.disposeAll())
  const adapter = new FixedAdapter()
  const pluginConfigs = {
    'agent-loop-runtime': { provider: 'test', model: 'test' },
    llm: { adapters: [{ providers: ['test'], adapter }] },
  }
  const first = await framework.manager.create({ id: 'character-one', presetId: 'character-agent', pluginConfigs })
  const second = await framework.manager.create({ id: 'character-two', presetId: 'character-agent', pluginConfigs })
  const director = await framework.manager.create({ id: 'director', presetId: 'director-agent', pluginConfigs })
  const firstPrompt = first.context.systemPrompt
  const secondPrompt = second.context.systemPrompt
  assert.notEqual(firstPrompt, secondPrompt)
  assert.equal(director.context.systemPrompt.getSection('character:identity'), undefined)

  const disposeExtra = firstPrompt.section({ name: 'test:instance', order: 1, text: '仅第一个角色' })
  assert.equal(secondPrompt.getSection('test:instance'), undefined)
  await first.run({ prompt: '林舟在渡口回应邀请。' })
  await second.run({ prompt: '另一角色回应邀请。' })
  const systems = adapter.requests.map(request => request.messages.find(message => message.role === 'system'))
  assert.deepEqual(systems[0]?.content, [{ type: 'text', text: '你是一个角色扮演 Agent。请根据当前提供的角色信息和场景，以角色的视角作出符合其认知和性格的反应。\n\n仅第一个角色' }])
  assert.deepEqual(systems[1]?.content, [{ type: 'text', text: '你是一个角色扮演 Agent。请根据当前提供的角色信息和场景，以角色的视角作出符合其认知和性格的反应。' }])
  disposeExtra()
  await framework.manager.dispose('character-one')
  assert.throws(() => firstPrompt.assemble(), /已销毁/)
  assert.ok(secondPrompt.getSection('character:identity'))
})
