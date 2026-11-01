import type { Context } from '@deepseek-ai/cordis'
import type {} from '@fly-novel/skill'
import type {} from '@fly-novel/tools'
import { createSkillTool } from './skill.js'

/** 将当前作用域的 Skill 服务绑定到工具，并在作用域销毁时注销工具。 */
export const skillToolPlugin = Object.assign(function skillToolPlugin(ctx: Context): void {
  const tool = createSkillTool(ctx.skills)
  ctx.effect(() => ctx.tools.register(tool))
}, { inject: ['skills', 'tools'] })

/** 应用注册后可由 Preset 选择的 Skill 工具插件。 */
export const skillToolPluginDefinition = {
  id: 'skill-tool', version: '1.0.0', description: '将当前 Agent 的 Skill 服务连接到工具', plugin: skillToolPlugin,
}
