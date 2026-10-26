import type { AgentPluginDefinition } from '../core/contracts/agent.js'
import { systemPromptPlugin, type SystemPromptPluginConfig } from '@fly-novel/system-prompt'

/** SystemPrompt 插件的 Harness 注册定义。 */
export const systemPromptPluginDefinition: AgentPluginDefinition<SystemPromptPluginConfig> = {
  id: 'system-prompt',
  version: '1.0.0',
  description: '为 Agent 实例提供系统提示词注册与组装服务',
  plugin: systemPromptPlugin,
  defaultConfig: {},
}
