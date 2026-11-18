import type { Context } from '@deepseek-ai/cordis'
import type {} from '@fly-novel/tools'
import { createHistoryTools } from './tools.js'
import type { HistoryStore } from './store.js'

/** 可信应用持有存储，插件作用域只负责注册和注销工具。 */
export interface HistoryToolsPluginConfig { store: HistoryStore; access: 'read-only' | 'read-write' }
export const historyToolsPlugin = Object.assign(function historyToolsPlugin(ctx: Context, config: HistoryToolsPluginConfig): void {
  const identity = ctx.tools.agent
  if (!identity) throw new Error('历史工具需要 Agent 身份')
  ctx.effect(() => {
    const disposers: (() => void)[] = []
    try { for (const tool of createHistoryTools(config.store, identity, config.access)) disposers.push(ctx.tools.register(tool)) }
    catch (error) { for (const dispose of disposers.reverse()) dispose(); throw error }
    return () => { for (const dispose of disposers.reverse()) dispose() }
  })
}, { inject: ['tools'] })
export const historyToolsPluginDefinition = { id: 'history-tools', version: '1.0.0', description: '注册历史事件工具', plugin: historyToolsPlugin }
