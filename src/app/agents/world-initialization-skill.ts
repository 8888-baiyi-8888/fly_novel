import type { Context } from '@deepseek-ai/cordis'
import type { SkillProvider } from '@fly-novel/skill'
import { FilesystemSkillProvider } from '@fly-novel/skill-filesystem'

/** 仅为应用内置 Skill 来源授予独立读取根，不扩大文件工具的读取视图。 */
export const worldInitializationSkillPlugin = Object.assign(function worldInitializationSkillPlugin(ctx: Context, config: { root: string }): void {
  const source = new FilesystemSkillProvider(config.root)
  const provider: SkillProvider = {
    name: source.name,
    list: (_workingDirectory, signal) => source.list(config.root, signal),
    get: (name, _workingDirectory, signal) => source.get(name, config.root, signal),
  }
  ctx.effect(() => ctx.skills.registerProvider(provider))
}, { inject: ['skills'] })

export const worldInitializationSkillPluginDefinition = {
  id: 'world-initialization-skill-source', version: '1.0.0', description: '注册可信的内置世界初始化 Skill 来源', plugin: worldInitializationSkillPlugin,
}
