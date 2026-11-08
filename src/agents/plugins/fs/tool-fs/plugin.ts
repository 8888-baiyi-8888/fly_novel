import type { Context } from '@deepseek-ai/cordis'
import { toolFsReadPlugin } from './read.js'
import { toolFsMutationPlugin } from './mutation.js'
import { toolFsPatchPlugin } from './apply-patch.js'

/** 文件工具组合配置；补丁必须由可信装配显式启用。 */
export interface ToolFsConfig { applyPatch?: boolean }

/** 为当前 Agent 注册文本文件工具，销毁时注销。 */
export const toolFsPlugin = Object.assign(async function toolFsPlugin(ctx: Context, config: ToolFsConfig = {}): Promise<void> {
  if (!config || typeof config !== 'object' || (config.applyPatch !== undefined && typeof config.applyPatch !== 'boolean')) throw new Error('文件工具配置无效')
  await ctx.plugin(toolFsReadPlugin)
  await ctx.plugin(toolFsMutationPlugin)
  if (config.applyPatch === true) await ctx.plugin(toolFsPatchPlugin)
}, { inject: ['tools', 'fs'] })

export const toolFsPluginDefinition = {
  id: 'tool-fs', version: '1.0.0', description: '注册文件读取与修改工具', plugin: toolFsPlugin,
}
