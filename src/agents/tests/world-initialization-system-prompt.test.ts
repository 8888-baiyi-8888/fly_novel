import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@fly-novel/llm'
import { bootstrapAgents } from '../core/bootstrap.js'

class FixedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '请说明你希望创造什么样的世界。' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

test('世界初始化提示词进入模型请求，按 Agent 隔离并随作用域清理', async (t) => {
  const framework = await bootstrapAgents()
  t.after(() => framework.manager.disposeAll())
  framework.presets.register({
    id: 'world-prompt-test',
    version: '1',
    role: 'director',
    plugins: [
      { pluginId: 'agent-loop-runtime' },
      { pluginId: 'system-prompt' },
      { pluginId: 'world-initialization-system-prompt' },
      { pluginId: 'llm' },
      { pluginId: 'session' },
    ],
  })
  const adapter = new FixedAdapter()
  const pluginConfigs = {
    'agent-loop-runtime': { provider: 'test', model: 'test' },
    llm: { adapters: [{ providers: ['test'], adapter }] },
  }
  const world = await framework.manager.create({ id: 'world-prompt', presetId: 'world-prompt-test', pluginConfigs })
  const director = await framework.manager.create({ id: 'director-prompt', presetId: 'director-agent', pluginConfigs })
  const prompt = world.context.systemPrompt
  assert.equal(director.context.systemPrompt.getSection('world-initialization:identity'), undefined)
  assert.equal(prompt.getSection('director:identity'), undefined)

  await world.run({ prompt: '我想创造一个不断变化的世界。' })
  const system = adapter.requests[0]?.messages.find(message => message.role === 'system')
  const section = prompt.getSection('world-initialization:identity')
  assert.equal(typeof section?.text, 'string')
  assert.deepEqual(system?.content, [{ type: 'text', text: section?.text }])
  assert.match(String(section?.text), /只调用实际提供的工具/)
  assert.match(String(section?.text), /子 Agent 看不到父会话/)
  assert.match(String(section?.text), /只有完整第一版生成并整合后才交付整体审阅/)

  await framework.manager.dispose('world-prompt')
  assert.throws(() => prompt.assemble(), /已销毁/)
  assert.ok(director.context.systemPrompt.getSection('director:identity'))
})
