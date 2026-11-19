import type { Context } from '@deepseek-ai/cordis'
import type {} from '@fly-novel/tools'
import { createSpecificTools } from './tools.js'
import type { SpecificStore } from './store.js'

/** 存储与引用由可信应用持有，插件作用域管理工具注册。 */
export interface SpecificToolsPluginConfig { store: SpecificStore; access: 'read-only' | 'read-write' }
export const specificToolsPlugin = Object.assign(function specificToolsPlugin(ctx: Context, config: SpecificToolsPluginConfig): void {
  const identity = ctx.tools.agent; if (!identity) throw new Error('世界专有内容工具需要 Agent 身份')
  ctx.effect(() => { const disposers: (() => void)[] = []; try { for (const tool of createSpecificTools(config.store, identity, config.access)) disposers.push(ctx.tools.register(tool)) } catch (error) { for (const dispose of disposers.reverse()) dispose(); throw error }; return () => { for (const dispose of disposers.reverse()) dispose() } })
}, { inject: ['tools'] })
export const specificToolsPluginDefinition = { id: 'world-specific-tools', version: '1.0.0', description: '注册世界专有内容工具', plugin: specificToolsPlugin }
