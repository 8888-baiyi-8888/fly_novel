import type { Context } from '@deepseek-ai/cordis'
import type { AgentPluginDefinition } from '../core/contracts/agent.js'
import { systemPrompt } from './system-prompt.js'

/** 为写作 Agent 注册正文写作提示词，随插件作用域注销。 */
export const writerSystemPromptPlugin = Object.assign(function writerSystemPromptPlugin(ctx: Context): void {
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'writer:identity',
    order: 0,
    text: systemPrompt,
    interpolate: false,
  }))
}, { inject: ['systemPrompt'] })

export const writerSystemPromptPluginDefinition: AgentPluginDefinition = {
  id: 'writer-system-prompt',
  version: '1.0.0',
  description: '注册写作 Agent 的系统提示词',
  plugin: writerSystemPromptPlugin,
}
