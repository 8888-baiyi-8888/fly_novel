import type { Context } from '@deepseek-ai/cordis'
import type { AgentPluginDefinition } from '../core/contracts/agent.js'

/** 为角色 Agent 注册角色职责提示词，随插件作用域注销。 */
export const characterSystemPromptPlugin = Object.assign(function characterSystemPromptPlugin(ctx: Context): void {
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'character:identity',
    order: 0,
    text: '你是一个角色扮演 Agent。请根据当前提供的角色信息和场景，以角色的视角作出符合其认知和性格的反应。',
  }))
}, { inject: ['systemPrompt'] })

export const characterSystemPromptPluginDefinition: AgentPluginDefinition = {
  id: 'character-system-prompt',
  version: '1.0.0',
  description: '注册角色 Agent 的系统提示词',
  plugin: characterSystemPromptPlugin,
}
