import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ToolCallId } from '@fly-novel/llm'
import { SubagentRuntime, subagentRunId } from '@fly-novel/subagent'
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
