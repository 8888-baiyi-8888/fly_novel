import type { Context, Plugin } from '@deepseek-ai/cordis'
import { SessionManager } from './session-manager.js'

export type SessionPluginConfig = Record<string, never>

export interface SessionPluginDefinition {
  id: string
  version: string
  description: string
  plugin: Plugin<SessionPluginConfig>
  defaultConfig: SessionPluginConfig
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessions: import('@fly-novel/session').SessionManager
  }
}

/** 为当前 Agent Context 提供独立 Session Manager。 */
export const sessionPlugin = Object.assign(function sessionPlugin(
  ctx: Context,
  _config: SessionPluginConfig = {},
): void {
  const sessions = new SessionManager()
  ctx.provide('sessions', sessions)
  ctx.effect(() => () => sessions.closeAll())
}, { provide: 'sessions' })

/** Session 插件的 Harness 注册定义。 */
export const sessionPluginDefinition: SessionPluginDefinition = {
  id: 'session',
  version: '1.0.0',
  description: '为 Agent 实例提供进程内 Session 管理服务',
  plugin: sessionPlugin,
  defaultConfig: {},
}
