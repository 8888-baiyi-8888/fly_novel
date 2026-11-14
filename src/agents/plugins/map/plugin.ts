import type { Context } from '@deepseek-ai/cordis'
import type {} from '@fly-novel/tools'
import { createMapTools } from './tools.js'
import type { MapStore } from './store.js'

/** 可信应用负责创建及关闭 store；插件只注册并注销工具。 */
export interface MapToolsPluginConfig { store: MapStore; access: 'read-only' | 'read-write' }

/** 将受控地图工具注册到当前 Agent，插件释放时撤销注册。 */
export const mapToolsPlugin = Object.assign(function mapToolsPlugin(ctx: Context, config: MapToolsPluginConfig): void {
  const identity = ctx.tools.agent
  if (!identity) throw new Error('地图工具需要 Agent 身份')
  ctx.effect(() => {
    const disposers: (() => void)[] = []
    try { for (const tool of createMapTools(config.store, identity, config.access)) disposers.push(ctx.tools.register(tool)) }
    catch (error) { for (const dispose of disposers.reverse()) dispose(); throw error }
    return () => { for (const dispose of disposers.reverse()) dispose() }
  })
}, { inject: ['tools'] })

export const mapToolsPluginDefinition = { id: 'map-tools', version: '1.0.0', description: '注册受可信地图存储约束的工具', plugin: mapToolsPlugin }
