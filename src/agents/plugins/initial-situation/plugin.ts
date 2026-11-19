import type { Context } from '@deepseek-ai/cordis'
import type {} from '@fly-novel/tools'
import { createSituationTools } from './tools.js'
import type { SituationStore } from './store.js'

/** 存储由可信应用持有；插件只管理工具注册的生命周期。 */
export interface SituationToolsPluginConfig { store: SituationStore; access: 'read-only' | 'read-write' }
export const situationToolsPlugin = Object.assign(function situationToolsPlugin(ctx: Context, config: SituationToolsPluginConfig): void {
  const identity = ctx.tools.agent; if (!identity) throw new Error('局势工具需要 Agent 身份')
  ctx.effect(() => {
    const disposers: (() => void)[] = []
    try { for (const tool of createSituationTools(config.store, identity, config.access)) disposers.push(ctx.tools.register(tool)) }
    catch (error) { for (const dispose of disposers.reverse()) dispose(); throw error }
    return () => { for (const dispose of disposers.reverse()) dispose() }
  })
}, { inject: ['tools'] })
export const situationToolsPluginDefinition = { id: 'situation-tools', version: '1.0.0', description: '注册初始局势工具', plugin: situationToolsPlugin }
