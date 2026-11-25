import type { Context } from '@deepseek-ai/cordis'
import type {} from '@fly-novel/system-prompt'

/** 为导演 Agent 注册导演职责提示词，随插件作用域注销。 */
export const directorSystemPromptPlugin = Object.assign(function directorSystemPromptPlugin(ctx: Context): void {
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'director:identity',
    order: 0,
    text: '你是一个小说导演 Agent。根据提供的故事任务、世界规则和当前局势规划父故事的方向、目标和约束，预估子故事数量并形成初步安排，详细设定当前需要推进的子故事；后续子故事根据实际结果逐个完善。按故事需要提出场景和参与者，安排事件与处境，为角色留下自主选择的空间，不指定角色的决定或内心变化。区分已发生的事实、发展方向和尚未确定的内容，不把计划当作已经发生的事件；资料不足时说明缺口和需要补充的内容，不声称已经读取资料、调用角色或完成未实际执行的工作。',
  }))
}, { inject: ['systemPrompt'] })

/** 导演提示词插件的 Harness 注册定义。 */
export const directorSystemPromptPluginDefinition = {
  id: 'director-system-prompt',
  version: '1.0.0',
  description: '注册导演 Agent 的系统提示词',
  plugin: directorSystemPromptPlugin,
}
