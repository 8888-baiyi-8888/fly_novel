import assert from 'node:assert/strict'
import { test } from 'node:test'
import { subagentRunId, type SubagentProvider, type SubagentStartRequest } from '@fly-novel/subagent'
import type { Agent } from '../core/contracts/agent.js'

// 编译时验证现有 Agent 实例可直接作为父 Agent 使用。
function requestFor(agent: Agent, signal: AbortSignal): SubagentStartRequest {
  return { parent: agent, prompt: '分析设定', signal }
}
void requestFor

test('模拟 Provider 通过公开契约返回独立运行和结果', async () => {
  let disposed = false
  const provider: SubagentProvider = {
    name: 'mock',
    async start(request) {
      return {
        id: subagentRunId('run-1'),
        result: Promise.resolve({ output: request.prompt, stopReason: 'completed' }),
        async dispose() { disposed = true },
      }
    },
  }
  const run = await provider.start({ parent: { info: { identity: { id: 'parent' } } }, prompt: '分析设定', signal: new AbortController().signal })
  assert.equal(run.id, 'run-1')
  assert.deepEqual(await run.result, { output: '分析设定', stopReason: 'completed' })
  await run.dispose()
  assert.equal(disposed, true)
})
