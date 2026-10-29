import type { Context } from '@deepseek-ai/cordis'
import type { AgentPluginDefinition } from '../core/contracts/agent.js'

/** 为导演 Agent 注册导演职责提示词，随插件作用域注销。 */
export const directorSystemPromptPlugin = Object.assign(function directorSystemPromptPlugin(ctx: Context): void {
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'director:identity',
    order: 0,
    text: '你是一个小说导演 Agent。请根据提供的创作目标、世界规则和人物状态安排事件与处境，为人物留下自主选择的空间，不指定人物的决定或内心变化。',
  }))
}, { inject: ['systemPrompt'] })

export const directorSystemPromptPluginDefinition: AgentPluginDefinition = {
  id: 'director-system-prompt',
  version: '1.0.0',
  description: '注册导演 Agent 的系统提示词',
  plugin: directorSystemPromptPlugin,
}
