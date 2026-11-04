import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bootstrapAgents, characterAgentPreset, createSpawnAgentCreator } from '@fly-novel/agents'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@fly-novel/llm'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(accept => { resolve = accept })
  return { promise, resolve }
}

class GatedAdapter extends LlmAdapter {
  readonly entered = deferred()
  readonly finish = deferred()
  prompt = ''
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.prompt = JSON.stringify(options.messages)
    this.entered.resolve()
    await this.finish.promise
    yield { type: 'block-start', index: 0, block: 'text' }
    yield { type: 'text-delta', index: 0, text: '角色建议' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '角色建议' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

test('公开包入口装配正式 Spawn，启动句柄早于任务完成', { timeout: 3000 }, async () => {
  const framework = await bootstrapAgents()
  const adapter = new GatedAdapter()
  const config = { 'agent-loop-runtime': { provider: 'example', model: 'test' }, llm: { adapters: [{ providers: ['example'], adapter }] } }
  const create = createSpawnAgentCreator(framework, { 'character-agent': config })
  framework.presets.register({ ...characterAgentPreset, id: 'public-spawn-parent', plugins: [
    ...characterAgentPreset.plugins, { pluginId: 'subagent' }, { pluginId: 'subagent-spawn-in-process' },
  ] })
  try {
    const parent = await framework.manager.create({ id: 'public-parent', presetId: 'public-spawn-parent', pluginConfigs: {
      ...config, 'subagent-spawn-in-process': { create },
    } })
    const run = await parent.context.subagents.start('spawn', {
      parent, presetId: 'character-agent', prompt: '检查角色动机', signal: new AbortController().signal,
    })
    await adapter.entered.promise
    let completed = false
    void run.result.then(() => { completed = true })
    await Promise.resolve()
    assert.equal(completed, false)
    assert.ok(run.id)
    assert.match(adapter.prompt, /检查角色动机/)
    assert.match(adapter.prompt, /角色扮演 Agent/)
    adapter.finish.resolve()
    assert.deepEqual(await run.result, { output: '角色建议', stopReason: 'completed' })
    await run.dispose()
    assert.deepEqual(framework.manager.list().map(agent => agent.info.identity.id), ['public-parent'])
  } finally {
    adapter.finish.resolve()
    await framework.manager.disposeAll()
  }
})
