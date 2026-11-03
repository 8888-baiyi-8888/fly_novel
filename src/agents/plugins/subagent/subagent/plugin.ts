import type { Context } from '@deepseek-ai/cordis'
import { SubagentRuntime } from './runtime.js'

declare module '@deepseek-ai/cordis' {
  interface Context { subagents: SubagentRuntime }
}

/** 在当前 Agent 作用域提供 Subagent 服务，销毁时等待未交付启动的清理。 */
export const subagentPlugin = Object.assign(function subagentPlugin(ctx: Context): void {
  const subagents = new SubagentRuntime()
  ctx.provide('subagents', subagents)
  ctx.effect(() => () => subagents.dispose())
}, { provide: 'subagents' })

/** Subagent 服务的 Harness 注册定义。 */
export const subagentPluginDefinition = {
  id: 'subagent', version: '1.0.0', description: '提供子 Agent 委派服务', plugin: subagentPlugin,
}
