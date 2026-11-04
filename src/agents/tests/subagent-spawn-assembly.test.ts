import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@fly-novel/llm'
import { subagentRunId, type SubagentStartRequest } from '@fly-novel/subagent'
import { startInProcessRun, type InProcessAgentCreator } from '@fly-novel/subagent-in-process-driver'
import { bootstrapAgents } from '../core/bootstrap.js'
import { EchoLlmAdapter, withAgentLoop } from './agent-loop-fixtures.js'

class CaptureAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, block: 'text' }
    yield { type: 'text-delta', index: 0, text: '分析完成' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '分析完成' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

test('可信创建函数可使用独立配置创建新 Agent 和会话', async () => {
  const framework = await bootstrapAgents()
  const childAdapter = new CaptureAdapter()
  const childIds: string[] = []
  framework.presets.register({ id: 'assembly-parent', version: '1', role: 'character',
    plugins: withAgentLoop([{ pluginId: 'tools' }]) })
  try {
    const parent = await framework.manager.create({
      id: 'assembly-parent', presetId: 'assembly-parent',
      pluginConfigs: {
        'agent-loop-runtime': { provider: 'parent-route', model: 'parent-model' },
        llm: { adapters: [{ providers: ['parent-route'], adapter: new EchoLlmAdapter() }] },
      },
    })
    await parent.run({ prompt: '仅父 Agent 知道的历史标记' })
    assert.ok(parent.context.get('tools'))
    const parentSessions = parent.context.get('sessions')?.list()
    assert.ok(parentSessions)
    assert.equal(parentSessions.length, 1)
    const parentEventCount = parentSessions[0]!.size

    // 测试用可信装配；实际 Spawn Provider 和配置校验尚未实现。
    const create: InProcessAgentCreator = async () => {
      const childId = `child-${randomUUID()}`
      const child = await framework.manager.create({
        id: childId, presetId: 'character-agent',
        pluginConfigs: {
          'agent-loop-runtime': { provider: 'child-route', model: 'child-model' },
          llm: { adapters: [{ providers: ['child-route'], adapter: childAdapter }] },
        },
      })
      childIds.push(childId)
      return { id: subagentRunId(randomUUID()), agent: child, dispose: () => framework.manager.dispose(childId) }
    }
    const request: SubagentStartRequest = { parent, prompt: '子任务原文', signal: new AbortController().signal }
    const [first, second] = await Promise.all([startInProcessRun(request, create), startInProcessRun(request, create)])
    assert.notEqual(first.id, second.id)
    assert.equal(new Set(childIds).size, 2)
    assert.equal(childIds.includes(first.id), false)
    assert.equal(childIds.includes(second.id), false)
    const children = childIds.map(id => framework.manager.get(id))
    const firstSession = children[0]?.context.get('sessions')?.list()[0]
    const secondSession = children[1]?.context.get('sessions')?.list()[0]
    assert.ok(firstSession)
    assert.ok(secondSession)
    assert.notEqual(firstSession.id, secondSession.id)
    assert.notEqual(firstSession.id, parentSessions[0]?.id)
    assert.notEqual(secondSession.id, parentSessions[0]?.id)
    assert.equal(children[0]?.context.get('tools'), undefined)
    assert.equal(children[1]?.context.get('tools'), undefined)
    assert.deepEqual(await Promise.all([first.result, second.result]), [
      { output: '分析完成', stopReason: 'completed' }, { output: '分析完成', stopReason: 'completed' },
    ])
    assert.equal(childAdapter.requests.length, 2)
    for (const call of childAdapter.requests) {
      assert.equal(call.provider, 'child-route')
      assert.equal(call.model, 'child-model')
      assert.match(JSON.stringify(call.messages), /子任务原文/)
      assert.doesNotMatch(JSON.stringify(call.messages), /仅父 Agent 知道的历史标记/)
    }
    assert.equal(parentSessions[0]!.size, parentEventCount)
    await Promise.all([first.dispose(), second.dispose()])
    for (const id of childIds) assert.throws(() => framework.manager.get(id), /不存在/)
  } finally {
    await framework.manager.disposeAll()
  }
})
