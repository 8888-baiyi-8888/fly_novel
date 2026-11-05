import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bootstrapAgents, characterAgentPreset, createForkAgentCreator } from '@fly-novel/agents'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@fly-novel/llm'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(accept => { resolve = accept })
  return { promise, resolve }
}

class FixedAdapter extends LlmAdapter {
  override async *stream(): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, block: 'text' }
    yield { type: 'text-delta', index: 0, text: '父回复' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '父回复' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class GatedAdapter extends LlmAdapter {
  readonly entered = deferred()
  readonly finish = deferred()
  messages = ''
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.messages = JSON.stringify(options.messages)
    this.entered.resolve()
    await this.finish.promise
    yield { type: 'block-start', index: 0, block: 'text' }
    yield { type: 'text-delta', index: 0, text: '子任务建议' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '子任务建议' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

test('公开包入口装配正式 Fork，启动后继承历史并交付结果', { timeout: 3000 }, async () => {
  const framework = await bootstrapAgents()
  const childAdapter = new GatedAdapter()
  const childConfig = { 'agent-loop-runtime': { provider: 'child', model: 'model' }, llm: { adapters: [{ providers: ['child'], adapter: childAdapter }] } }
  const create = createForkAgentCreator(framework, { 'character-agent': childConfig })
  framework.presets.register({ ...characterAgentPreset, id: 'public-fork-parent', plugins: [
    ...characterAgentPreset.plugins, { pluginId: 'subagent' }, { pluginId: 'subagent-fork-in-process' },
  ] })
  try {
    const parent = await framework.manager.create({ id: 'parent', presetId: 'public-fork-parent', pluginConfigs: {
      'agent-loop-runtime': { provider: 'parent', model: 'model' }, llm: { adapters: [{ providers: ['parent'], adapter: new FixedAdapter() }] },
      'subagent-fork-in-process': { create },
    } })
    await parent.run({ prompt: '父会话已完成的历史' })
    const run = await parent.context.subagents.start('fork', {
      parent, presetId: 'character-agent', prompt: '角色任务原文', parameters: { characterId: 'role-a' }, signal: new AbortController().signal,
    })
    await childAdapter.entered.promise
    let completed = false
    void run.result.then(() => { completed = true })
    await Promise.resolve()
    assert.equal(completed, false)
    assert.ok(run.id)
    assert.match(childAdapter.messages, /父会话已完成的历史/)
    assert.match(childAdapter.messages, /角色任务原文/)
    const child = framework.manager.list().find(agent => agent !== parent)!
    assert.equal(child.info.parameters.characterId, 'role-a')
    assert.notEqual(child.context.sessions.list()[0]!.id, parent.context.sessions.list()[0]!.id)
    childAdapter.finish.resolve()
    assert.deepEqual(await run.result, { output: '子任务建议', stopReason: 'completed' })
    await run.dispose()
    assert.deepEqual(framework.manager.list().map(agent => agent.info.identity.id), ['parent'])
  } finally { childAdapter.finish.resolve(); await framework.manager.disposeAll() }
})
