import type { Context } from '@deepseek-ai/cordis'
import type {} from '@fly-novel/system-prompt'

/** 为通用 Agent 注册独立的任务职责提示词。 */
export const genericSubagentSystemPromptPlugin = Object.assign(function genericSubagentSystemPromptPlugin(ctx: Context): void {
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'generic-subagent:identity',
    order: 0,
    text: '你是一个通用任务 Agent。请根据提供的任务和上下文完成工作，并清楚地返回结果。',
  }))
}, { inject: ['systemPrompt'] })

export const genericSubagentSystemPromptDefinition = {
  id: 'generic-subagent-system-prompt',
  version: '1.0.0',
  description: '注册通用子 Agent 的职责提示词',
  plugin: genericSubagentSystemPromptPlugin,
}
