import { defineTool } from '@fly-novel/tools'
import type { SubagentRuntime } from '@fly-novel/subagent'
import { z } from 'zod'

const input = z.object({ task: z.string().trim().min(1) }).strict()

/** 绑定父 Agent 与持久历史 Agent，身份和世界由可信应用提供。 */
export function createHistoryDelegationTool(subagents: SubagentRuntime, parentId: string) {
  if (!parentId.trim()) throw new Error('历史委派工具需要父 Agent 身份')
  if (!subagents.getProvider('persistent')) throw new Error('历史委派工具需要已注册的 persistent Provider')
  return defineTool({ name: 'delegate_history', description: '委派历史设定或历史负责人的目录任务；子 Agent 看不到父会话，请提供必要背景。',
    parameters: { task: { type: 'string', required: true, description: '历史任务、用户要求及必要背景。' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const { task } = input.parse(args)
      if (!exec.agent || exec.agent.id !== parentId) throw new Error('历史委派工具需要当前父 Agent 身份')
      const run = await subagents.start('persistent', { parent: { info: { identity: { id: parentId } } }, presetId: 'history-agent', prompt: task, signal: exec.signal })
      const [execution] = await Promise.allSettled([run.result.then(result => {
        if (result.stopReason === 'error') throw new Error(`历史任务失败${result.errorCode ? ` (${result.errorCode})` : ''}`)
        if (result.stopReason === 'aborted') throw new Error('历史任务已取消')
        return result.output
      })])
      const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())])
      if (execution.status === 'rejected') {
        if (disposal.status === 'rejected') throw new AggregateError([execution.reason, disposal.reason], '历史任务和资源释放均失败')
        throw execution.reason
      }
      if (disposal.status === 'rejected') throw disposal.reason
      return execution.value
    },
  })
}
