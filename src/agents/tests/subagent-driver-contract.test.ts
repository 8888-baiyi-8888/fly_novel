import assert from 'node:assert/strict'
import { test } from 'node:test'
import { subagentRunId, type SubagentRunId, type SubagentStartRequest } from '@fly-novel/subagent'
import type { InProcessAgent, InProcessAgentCreator, InProcessRunDriver } from '@fly-novel/subagent-in-process-driver'
import type { Agent, CreateAgentOptions } from '../core/index.js'
import type { AgentManager } from '../runtime/agent-manager.js'

// 编译时验证真实 Agent 和 Manager 可由调用方适配，Driver 包无需依赖 Agent 包。
function asDriverAgent(agent: Agent): InProcessAgent { return agent }
function creatorFromManager(manager: AgentManager, options: CreateAgentOptions, id: SubagentRunId): InProcessAgentCreator {
  return async () => {
    const agent = await manager.create(options)
    return { id, agent: asDriverAgent(agent), dispose: () => manager.dispose(options.id) }
  }
}
function asCreatorConsumer(driver: InProcessRunDriver, request: SubagentStartRequest, creator: InProcessAgentCreator) {
  return driver(request, creator)
}
void creatorFromManager
void asCreatorConsumer

test('创建方契约可携带任务请求并返回模拟 Agent 与清理句柄', async () => {
  let disposed = false
  const create: InProcessAgentCreator = async request => ({
    id: subagentRunId('mock-run'),
    agent: { async run(input) { return { content: input.prompt } }, cancel() {} },
    async dispose() { disposed = true },
  })
  const request: SubagentStartRequest = { parent: { info: { identity: { id: 'parent' } } }, prompt: '原始任务', signal: new AbortController().signal }
  const handle = await create(request)
  assert.equal(handle.id, 'mock-run')
  assert.deepEqual(await handle.agent.run({ prompt: request.prompt }), { content: '原始任务' })
  await handle.dispose()
  assert.equal(disposed, true)
})
