import type { Context } from '@deepseek-ai/cordis'
import type {} from '@fly-novel/tools'
import type { OrganizationStore } from './store.js'
import type { OrganizationQueryBinding } from './query.js'
import { createOrganizationTools } from './tools.js'

/** 可信应用持有存储及授权提供者；插件只负责注册及注销工具。 */
export interface OrganizationToolsPluginConfig { store: OrganizationStore; binding: OrganizationQueryBinding; access: 'read-only' | 'read-write' }
export const organizationToolsPlugin = Object.assign(function organizationToolsPlugin(ctx: Context, config: OrganizationToolsPluginConfig): void {
  const identity = ctx.tools.agent
  if (!identity) throw new Error('组织工具需要 Agent 身份')
  ctx.effect(() => {
    const disposers: (() => void)[] = []
    try { for (const tool of createOrganizationTools(config.store, identity, config.binding, config.access)) disposers.push(ctx.tools.register(tool)) }
    catch (error) { for (const dispose of disposers.reverse()) dispose(); throw error }
    return () => { for (const dispose of disposers.reverse()) dispose() }
  })
}, { inject: ['tools'] })

export const organizationToolsPluginDefinition = { id: 'organization-tools', version: '1.0.0', description: '按可信身份注册组织资料工具', plugin: organizationToolsPlugin }
