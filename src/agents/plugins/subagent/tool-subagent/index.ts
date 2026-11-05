import type { Context } from '@deepseek-ai/cordis'
import type {} from '@fly-novel/subagent'
import { defineTool } from '@fly-novel/tools'

/** 在当前 Agent 作用域注册前台通用委派工具，卸载时注销。 */
export const toolSubagentPlugin = Object.assign(function toolSubagentPlugin(ctx: Context): void {
  if (!ctx.subagents.getProvider('spawn')) throw new Error('通用委派工具需要已注册的 spawn Provider')
  const parentId = ctx.agent.id
  const tool = defineTool({
    name: 'delegate',
    description: '将通用任务交给独立子 Agent；子 Agent 看不到当前会话，请在任务中提供必要上下文。',
    parameters: { task: { type: 'string', required: true, description: '交给子 Agent 的完整任务说明。' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute({ task }, exec) {
      if (!task.trim()) throw new Error('委派任务不能为空')
      if (!exec.agent || exec.agent.id !== parentId) throw new Error('委派工具需要当前父 Agent 身份')
      const run = await ctx.subagents.start('spawn', {
        parent: { info: { identity: { id: parentId } } },
        presetId: 'generic-subagent', prompt: task, signal: exec.signal,
      })
      const [execution] = await Promise.allSettled([run.result.then(result => {
        if (result.stopReason === 'error') throw new Error(`子任务执行失败${result.errorCode ? ` (${result.errorCode})` : ''}`)
        if (result.stopReason === 'aborted') throw new Error('子任务已取消')
        return result.output
      })])
      const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())])
      if (execution.status === 'rejected') {
        if (disposal.status === 'rejected') throw new AggregateError([execution.reason, disposal.reason], '子任务执行失败且资源释放失败')
        throw execution.reason
      }
      if (disposal.status === 'rejected') throw disposal.reason
      return execution.value
    },
  })
  ctx.effect(() => ctx.tools.register(tool))
}, { inject: ['agent', 'tools', 'subagents'] })

/** 由 Preset 选择的通用委派工具注册定义。 */
export const toolSubagentPluginDefinition = {
  id: 'tool-subagent', version: '1.0.0', description: '注册通用子 Agent 委派工具', plugin: toolSubagentPlugin,
}
