import { defineTool } from '@fly-novel/tools'
import type { SubagentRuntime } from '@fly-novel/subagent'

/** 为父 Agent 创建角色设定专用委派工具；可信调用方负责注册和注销。 */
export function createCharacterCreatorDelegationTool(subagents: SubagentRuntime, parentId: string) {
  if (!parentId.trim()) throw new Error('角色创建委派工具需要父 Agent 身份')
  if (!subagents.getProvider('persistent')) throw new Error('角色创建委派工具需要已注册的 persistent Provider')
  return defineTool({
    name: 'delegate_character_creator',
    description: '委派角色设定创建、修改或更新该角色 Agent 负责的资料目录简介；子 Agent 看不到父会话，请提供任务和必要背景。结果为建议，不代表用户已确认。',
    parameters: { task: { type: 'string', required: true, description: '角色创建或修改任务及必要上下文。' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute({ task }, exec) {
      if (!task.trim()) throw new Error('角色创建任务不能为空')
      if (!exec.agent || exec.agent.id !== parentId) throw new Error('角色创建委派工具需要当前父 Agent 身份')
      const run = await subagents.start('persistent', { parent: { info: { identity: { id: parentId } } },
        presetId: 'character-creator', prompt: task, signal: exec.signal })
      const [execution] = await Promise.allSettled([run.result.then(result => {
        if (result.stopReason === 'error') throw new Error(`角色创建任务失败${result.errorCode ? ` (${result.errorCode})` : ''}`)
        if (result.stopReason === 'aborted') throw new Error('角色创建任务已取消')
        return result.output
      })])
      const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())])
      if (execution.status === 'rejected') {
        if (disposal.status === 'rejected') throw new AggregateError([execution.reason, disposal.reason], '角色创建任务和资源释放均失败')
        throw execution.reason
      }
      if (disposal.status === 'rejected') throw disposal.reason
      return execution.value
    },
  })
}
