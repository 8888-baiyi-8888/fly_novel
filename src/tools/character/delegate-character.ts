import { defineTool } from '@fly-novel/tools'
import type { SubagentRuntime } from '@fly-novel/subagent'

/**
 * 创建角色专用委派工具；由可信调用方负责注册与注销。
 * @param subagents 当前父 Agent 作用域的委派服务。
 * @param parentId 同一父 Agent 的身份标识。
 * @returns 可注册到父 Agent 工具服务的工具定义。
 * @throws 父身份为空时抛错；调用失败由工具服务处理。
 */
export function createCharacterDelegationTool(subagents: SubagentRuntime, parentId: string) {
  if (!parentId.trim()) throw new Error('角色委派工具需要父 Agent 身份')
  return defineTool({
    name: 'delegate_character',
    description: '将任务交给角色 Agent。角色资料需由调用方在任务中提供，子 Agent 看不到当前会话。',
    parameters: {
      task: { type: 'string', required: true, description: '角色任务及完成任务所需的上下文。' },
      characterId: { type: 'string', required: true, description: '本次任务的角色标识。' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute({ task, characterId }, exec) {
      if (!task.trim()) throw new Error('委派任务不能为空')
      if (!characterId || characterId.trim() !== characterId) throw new Error('characterId 必须非空且不能包含首尾空白')
      if (!exec.agent || exec.agent.id !== parentId) throw new Error('角色委派工具需要当前父 Agent 身份')
      const run = await subagents.start('spawn', {
        parent: { info: { identity: { id: parentId } } }, presetId: 'character-agent',
        prompt: task, parameters: { characterId }, signal: exec.signal,
      })
      const [execution] = await Promise.allSettled([run.result.then(result => {
        if (result.stopReason === 'error') throw new Error(`角色子任务执行失败${result.errorCode ? ` (${result.errorCode})` : ''}`)
        if (result.stopReason === 'aborted') throw new Error('角色子任务已取消')
        return result.output
      })])
      const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())])
      if (execution.status === 'rejected') {
        if (disposal.status === 'rejected') throw new AggregateError([execution.reason, disposal.reason], '角色子任务执行失败且资源释放失败')
        throw execution.reason
      }
      if (disposal.status === 'rejected') throw disposal.reason
      return execution.value
    },
  })
}
