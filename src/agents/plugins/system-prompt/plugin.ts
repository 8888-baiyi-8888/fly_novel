import type { Context, Plugin } from '@deepseek-ai/cordis'
import type { AgentPluginDefinition } from '../../core/contracts/agent.js'
import { SystemPrompt } from './system-prompt.js'

export type SystemPromptPluginConfig = Record<string, never>

declare module '@deepseek-ai/cordis' {
  interface Context {
    systemPrompt: SystemPrompt
  }
}

/** 为当前 Agent Context 提供独立的 SystemPrompt 服务。 */
export const systemPromptPlugin = Object.assign(function systemPromptPlugin(
  ctx: Context,
  _config: SystemPromptPluginConfig = {},
): void {
  const systemPrompt = new SystemPrompt()
  ctx.provide('systemPrompt', systemPrompt)
  ctx.effect(() => () => systemPrompt.dispose())
}, { provide: 'systemPrompt' })

/** SystemPrompt 插件的 Harness 注册定义。 */
export const systemPromptPluginDefinition: AgentPluginDefinition<SystemPromptPluginConfig> = {
  id: 'system-prompt',
  version: '1.0.0',
  description: '为 Agent 实例提供系统提示词注册与组装服务',
  plugin: systemPromptPlugin as Plugin<SystemPromptPluginConfig>,
  defaultConfig: {},
}
