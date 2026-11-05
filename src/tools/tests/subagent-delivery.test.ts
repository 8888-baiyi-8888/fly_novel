import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bootstrapAgents, characterAgentPreset, createSpawnAgentCreator } from '@fly-novel/agents'
import { LlmAdapter, type GenerateOptions, type StreamChunk, type ToolCallId } from '@fly-novel/llm'
import { createCharacterDelegationTool } from '../index.js'

class ParentAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.requests.length <= 2) {
      const first = this.requests.length === 1
      const call = first
        ? { id: 'general' as ToolCallId, name: 'delegate', arguments: JSON.stringify({ task: '  通用任务  ' }) }
        : { id: 'character' as ToolCallId, name: 'delegate_character', arguments: JSON.stringify({ task: '  角色任务  ', characterId: 'role-1' }) }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', ...call } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const outputs = options.messages.flatMap(message => message.content)
      .filter(block => block.type === 'tool-result')
      .flatMap(block => block.content)
      .filter(block => block.type === 'text')
      .map(block => block.text)
    const text = outputs.join(' / ')
    yield { type: 'block-start', index: 0, block: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class ChildAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly output: string, private readonly inspect: () => void) { super() }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    this.inspect()
    yield { type: 'block-start', index: 0, block: 'text' }
    yield { type: 'text-delta', index: 0, text: this.output }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: this.output } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

test('公开入口装配两种工具，父 Agent 连续接收各自子任务结果', async () => {
  const framework = await bootstrapAgents()
  const parentAdapter = new ParentAdapter()
  const sessions: string[] = []
  const inspect = () => {
    const children = framework.manager.list().filter(agent => agent.info.identity.id.startsWith('subagent-'))
    assert.equal(children.length, 1)
    const session = children[0]!.context.sessions.list()[0]
    assert.ok(session)
    sessions.push(session.id)
  }
  const general = new ChildAdapter('通用建议', inspect)
  const character = new ChildAdapter('角色建议', inspect)
  const childConfig = (adapter: LlmAdapter) => ({
    'agent-loop-runtime': { provider: 'child', model: 'model' },
    llm: { adapters: [{ providers: ['child'], adapter }] },
  })
  const creator = createSpawnAgentCreator(framework, { 'generic-subagent': childConfig(general), 'character-agent': childConfig(character) })
  const created: Array<{ runId: string, preset: string, characterId: unknown }> = []
  const create: typeof creator = async request => {
    const result = await creator(request)
    const child = framework.manager.list().find(agent => agent === result.agent)
    assert.ok(child)
    created.push({ runId: result.id, preset: child.info.presetId, characterId: child.info.parameters.characterId })
    return result
  }
  framework.presets.register({ ...characterAgentPreset, id: 'delivery-parent', plugins: [
    ...characterAgentPreset.plugins, { pluginId: 'tools' }, { pluginId: 'subagent' },
    { pluginId: 'subagent-spawn-in-process' }, { pluginId: 'tool-subagent' },
  ] })
  framework.presets.register({ ...characterAgentPreset, id: 'delivery-other', plugins: [
    ...characterAgentPreset.plugins, { pluginId: 'tools' },
  ] })
  const parentConfig = {
    'agent-loop-runtime': { provider: 'parent', model: 'model', workingDirectory: process.cwd() },
    llm: { adapters: [{ providers: ['parent'], adapter: parentAdapter }] },
    'subagent-spawn-in-process': { create },
  }
  try {
    const parent = await framework.manager.create({ id: 'parent', presetId: 'delivery-parent', pluginConfigs: parentConfig })
    const other = await framework.manager.create({ id: 'other', presetId: 'delivery-other', pluginConfigs: childConfig(general) })
    assert.deepEqual(parent.context.tools.schemas().map(tool => tool.name), ['delegate'])
    assert.deepEqual(other.context.tools.schemas(), [])
    parent.context.tools.register(createCharacterDelegationTool(parent.context.subagents, parent.info.identity.id))
    assert.deepEqual(other.context.tools.schemas(), [])
    for (const args of [{ task: '任务' }, { task: '任务', characterId: '' }, { task: '任务', characterId: ' role-1' }]) {
      const response = await parent.context.tools.execute({ calls: [{ type: 'tool-call', id: 'invalid' as ToolCallId,
        name: 'delegate_character', arguments: JSON.stringify(args) }], signal: new AbortController().signal, workingDirectory: process.cwd() })
      assert.equal(response.results[0]!.result.isError, true)
    }
    assert.equal(created.length, 0)
    assert.equal(framework.manager.list().length, 2)
    assert.deepEqual(await parent.run({ prompt: '父会话私有内容' }), { content: '通用建议 / 角色建议' })

    const tools = parentAdapter.requests[0]!.tools!
    const generalSchema = tools.find(tool => tool.name === 'delegate')!
    const characterSchema = tools.find(tool => tool.name === 'delegate_character')!
    assert.deepEqual(generalSchema.parameters.required, ['task'])
    assert.deepEqual(characterSchema.parameters.required, ['task', 'characterId'])
    assert.deepEqual(created.map(item => [item.preset, item.characterId]), [['generic-subagent', undefined], ['character-agent', 'role-1']])
    assert.equal(new Set(created.map(item => item.runId)).size, 2)
    const parentSession = parent.context.sessions.list()[0]!
    assert.equal(new Set([parentSession.id, ...sessions]).size, 3)
    const results = parentSession.read().filter(event => event.type === 'tool/result')
    assert.deepEqual(results.map(event => event.data.message.source.callId), ['general', 'character'])
    assert.match(JSON.stringify(parentAdapter.requests[1]!.messages), /通用建议/)
    assert.match(JSON.stringify(parentAdapter.requests[2]!.messages), /角色建议/)
    for (const [adapter, task] of [[general, '  通用任务  '], [character, '  角色任务  ']] as const) {
      const messages = JSON.stringify(adapter.requests[0]!.messages)
      assert.ok(messages.includes(task))
      assert.doesNotMatch(messages, /父会话私有内容|role-1/)
    }
    assert.deepEqual(framework.manager.list().map(agent => agent.info.identity.id).sort(), ['other', 'parent'])
  } finally { await framework.manager.disposeAll() }
})
