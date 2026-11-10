import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ToolCallId } from '@fly-novel/llm'
import { SubagentRuntime, subagentRunId } from '@fly-novel/subagent'
import { createPersistentAgentCreator, createPersistentAgentRouter } from '@fly-novel/subagent-persistent-in-process'
import { startInProcessRun } from '@fly-novel/subagent-in-process-driver'
import { defineTool } from '@fly-novel/tools'
import { createCharacterCreatorDelegationTool } from '../character/delegate-character-creator.js'

const exec = { callId: 'call' as ToolCallId, name: 'delegate_character_creator',
  agent: { id: 'parent', name: 'parent', role: 'general' }, workingDirectory: process.cwd(), signal: new AbortController().signal }

test('角色创建委派拒绝缺失 Provider、空任务和错误父身份', async () => {
  const subagents = new SubagentRuntime()
  assert.throws(() => createCharacterCreatorDelegationTool(subagents, 'parent'), /persistent Provider/)
  let starts = 0
  subagents.registerProvider({ name: 'persistent', start() { starts++; throw new Error('不应启动') } })
  const tool = createCharacterCreatorDelegationTool(subagents, 'parent')
  await assert.rejects(tool.execute({ task: ' ' }, exec), /不能为空/)
  await assert.rejects(tool.execute({ task: '创建' }, { ...exec, agent: { ...exec.agent, id: 'other' } }), /父 Agent 身份/)
  assert.equal(starts, 0)
  await subagents.dispose()
})

test('角色任务和释放同时失败时保留两个原因', async () => {
  const subagents = new SubagentRuntime()
  const executionError = new Error('执行失败')
  const disposalError = new Error('释放失败')
  subagents.registerProvider({ name: 'persistent', start(request) {
    assert.equal(request.presetId, 'character-creator')
    assert.equal(request.parameters, undefined)
    return Promise.resolve({ id: subagentRunId('run'), result: Promise.reject(executionError), async dispose() { throw disposalError } })
  } })
  const tool = createCharacterCreatorDelegationTool(subagents, 'parent')
  await assert.rejects(tool.execute({ task: '创建' }, exec), (error: unknown) =>
    error instanceof AggregateError && error.errors[0] === executionError && error.errors[1] === disposalError)
  await subagents.dispose()
})

test('固定专用工具只能路由自己的可信绑定，第二种职责由测试装配', async () => {
  const subagents = new SubagentRuntime()
  const make = (presetId: string) => createPersistentAgentCreator({ presetId, sessionMode: 'resume', async create() {
    return { agent: { async run() { return { content: presetId } }, cancel() {} }, async dispose() {} }
  } })
  const create = createPersistentAgentRouter({ 'character-creator': make('character-creator'), 'test-history': make('test-history') })
  subagents.registerProvider({ name: 'persistent', supportsParameters: false, start: request => startInProcessRun(request, create) })
  const character = createCharacterCreatorDelegationTool(subagents, 'parent')
  assert.equal(await character.execute({ task: '角色' }, exec), 'character-creator')
  const history = defineTool({ name: 'delegate_test_history', description: '测试历史职责',
    parameters: { task: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute({ task }, context) {
      const run = await subagents.start('persistent', { parent: { info: { identity: { id: 'parent' } } },
        presetId: 'test-history', prompt: task, signal: context.signal })
      try { return (await run.result).output } finally { await run.dispose() }
    },
  })
  assert.equal(await history.execute({ task: '历史' }, exec), 'test-history')
  await assert.rejects(subagents.start('persistent', { parent: { info: { identity: { id: 'parent' } } },
    presetId: 'unconfigured', prompt: '任务', signal: exec.signal }), /绑定/)
  await subagents.dispose()
})
