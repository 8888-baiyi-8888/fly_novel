import { defineTool } from '@fly-novel/tools'
import type { SubagentRuntime } from '@fly-novel/subagent'
import { z } from 'zod'

const input = z.object({ task: z.string().trim().min(1) }).strict()

/** 绑定父 Agent 与持久世界发展规划 Agent，身份和世界由可信应用提供。 */
export function createWorldDevelopmentDelegationTool(subagents: SubagentRuntime, parentId: string) {
  if (!parentId.trim()) throw new Error('世界发展规划委派工具需要父 Agent 身份')
  if (!subagents.getProvider('persistent')) throw new Error('世界发展规划委派工具需要已注册的 persistent Provider')
  return defineTool({ name: 'delegate_world_development', description: '委派宏观发展、故事线或人物成长规划；子 Agent 看不到父会话，请提供必要背景。',
    parameters: { task: { type: 'string', required: true, description: '规划任务、用户要求及必要背景。' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const { task } = input.parse(args)
      if (!exec.agent || exec.agent.id !== parentId) throw new Error('世界发展规划委派工具需要当前父 Agent 身份')
      const run = await subagents.start('persistent', { parent: { info: { identity: { id: parentId } } }, presetId: 'world-development-agent', prompt: task, signal: exec.signal })
      const [execution] = await Promise.allSettled([run.result.then(result => {
        if (result.stopReason === 'error') throw new Error(`世界发展规划任务失败${result.errorCode ? ` (${result.errorCode})` : ''}`)
        if (result.stopReason === 'aborted') throw new Error('世界发展规划任务已取消')
        return result.output
      })])
      const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())])
      if (execution.status === 'rejected') {
        if (disposal.status === 'rejected') throw new AggregateError([execution.reason, disposal.reason], '世界发展规划任务和资源释放均失败')
        throw execution.reason
      }
      if (disposal.status === 'rejected') throw disposal.reason
      return execution.value
    },
  })
}
