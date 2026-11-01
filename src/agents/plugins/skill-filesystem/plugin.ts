import type { Context } from '@deepseek-ai/cordis'
import type {} from '@fly-novel/skill'
import { FilesystemSkillProvider } from './filesystem-skill-provider.js'

export interface FilesystemSkillPluginConfig {
  /** 可信装配指定的绝对 Skill 根目录。 */
  readonly root: string
}

/** 向 Skill 服务注册指定目录；插件作用域销毁时注销。 */
export const filesystemSkillPlugin = Object.assign(function filesystemSkillPlugin(
  ctx: Context, config: FilesystemSkillPluginConfig,
): void {
  const provider = new FilesystemSkillProvider(config.root)
  ctx.effect(() => ctx.skills.registerProvider(provider))
}, { inject: ['skills'] })

/** 文件系统 Skill 来源插件的 Harness 注册定义；装配时必须提供 root。 */
export const filesystemSkillPluginDefinition = {
  id: 'skill-filesystem', version: '1.0.0', description: '注册文件系统 Skill 来源', plugin: filesystemSkillPlugin,
}
