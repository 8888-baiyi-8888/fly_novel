import type { Context } from '@deepseek-ai/cordis'
import type { AgentPluginDefinition } from '../../core/contracts/agent.js'
import { ToolsService } from './tools-service.js'

declare module '@deepseek-ai/cordis' {
  interface Context { tools: ToolsService }
}

/** 为当前 Agent 提供工具服务，并随插件作用域清理。 */
export const toolsPlugin = Object.assign(function toolsPlugin(ctx: Context): void {
  const tools = new ToolsService()
  ctx.provide('tools', tools)
  ctx.effect(() => () => tools.dispose())
}, { provide: 'tools' })

/** Tools 插件的 Harness 注册定义。 */
export const toolsPluginDefinition: AgentPluginDefinition = {
  id: 'tools', version: '1.0.0', description: '为 Agent 实例提供工具注册服务', plugin: toolsPlugin,
}
