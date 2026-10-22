import type { Context, Plugin } from '@deepseek-ai/cordis'
import { Session } from './session.js'

export interface SessionPluginConfig {
  /** 调用方分配的会话标识；未提供时生成随机 UUID。 */
  sessionId?: string
}

export interface SessionPluginDefinition {
  id: string
  version: string
  description: string
  plugin: Plugin<SessionPluginConfig>
  defaultConfig: SessionPluginConfig
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    session: import('@fly-novel/session').Session
  }
}

/** 为当前 Agent Context 提供独立内存 Session。 */
export const sessionPlugin = Object.assign(function sessionPlugin(
  ctx: Context,
  config: SessionPluginConfig = {},
): void {
  const session = new Session({
    id: config.sessionId,
  })
  ctx.provide('session', session)
  ctx.effect(() => () => session.close())
}, { provide: 'session' })

/** Session 插件的 Harness 注册定义。 */
export const sessionPluginDefinition: SessionPluginDefinition = {
  id: 'session',
  version: '1.0.0',
  description: '为 Agent 实例提供进程内会话事件记录',
  plugin: sessionPlugin,
  defaultConfig: {},
}
