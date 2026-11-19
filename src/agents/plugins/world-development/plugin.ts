import type { Context } from '@deepseek-ai/cordis'
import type {} from '@fly-novel/tools'
import { createDevelopmentTools } from './tools.js'
import type { DevelopmentStore } from './store.js'

/** 存储与引用由可信应用持有，插件作用域管理工具注册。 */
export interface DevelopmentToolsPluginConfig { store: DevelopmentStore; access: 'read-only' | 'read-write' }
export const developmentToolsPlugin = Object.assign(function developmentToolsPlugin(ctx: Context, config: DevelopmentToolsPluginConfig): void {
  const identity = ctx.tools.agent; if (!identity) throw new Error('世界发展规划工具需要 Agent 身份')
  ctx.effect(() => { const disposers: (() => void)[] = []; try { for (const tool of createDevelopmentTools(config.store, identity, config.access)) disposers.push(ctx.tools.register(tool)) } catch (error) { for (const dispose of disposers.reverse()) dispose(); throw error }; return () => { for (const dispose of disposers.reverse()) dispose() } })
}, { inject: ['tools'] })
export const developmentToolsPluginDefinition = { id: 'world-development-tools', version: '1.0.0', description: '注册世界发展规划工具', plugin: developmentToolsPlugin }
