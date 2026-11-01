import type { AgentPluginDefinition } from '../../core/contracts/agent.js'
import { worldInitializationSystemPromptPlugin } from '@fly-novel/world-initialization-system-prompt'

/** 世界初始化主 Agent 提示词插件的 Harness 注册定义。 */
export const worldInitializationSystemPromptPluginDefinition: AgentPluginDefinition = {
  id: 'world-initialization-system-prompt',
  version: '1.0.0',
  description: '注册世界初始化主 Agent 的系统提示词',
  plugin: worldInitializationSystemPromptPlugin,
}
