import type { Context } from '@deepseek-ai/cordis'
import type {} from '@fly-novel/skill'
import type {} from '@fly-novel/tools'
import type { ModelStepContext } from '@fly-novel/agent-loop'
import { createSkillTool } from '@fly-novel/skill-tool-core'

/** 将当前作用域的 Skill 服务绑定到工具，并在作用域销毁时注销工具。 */
export const toolSkillPlugin = Object.assign(function toolSkillPlugin(ctx: Context): void {
  const tool = createSkillTool(ctx.skills)
  ctx.effect(() => {
    try {
      return ctx.tools.register(tool)
    } catch (error) {
      console.error(`工具 "${tool.name}" 注册失败：`, error)
      return () => {}
    }
  })
  const context: ModelStepContext = {
    async prepare({ workingDirectory, signal }) {
      if (ctx.tools.get('skill') !== tool) return ''
      if (!workingDirectory) throw new Error('Skill 目录查询需要授权工作目录')
      const skills = (await ctx.skills.list(workingDirectory, signal)).filter(item => item.invocation.modelInvocable)
      if (skills.length === 0) return ''
      return [
        '<system-reminder>',
        '以下是可用 Skill 的名称和用途；在任务匹配时，先使用 skill 工具按准确名称加载完整指导。摘要不包含完整指导。',
        '<available_skills>',
        ...skills.map(item => `- \`${escapeText(item.name)}\`: ${escapeText(item.description.replace(/\s+/g, ' ').trim().slice(0, 500))}`),
        '</available_skills>',
        '</system-reminder>',
      ].join('\n')
    },
  }
  ctx.provide('modelStepContext', context)
}, { inject: ['skills', 'tools'], provide: 'modelStepContext' })

function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

/** 应用注册后可由 Preset 选择的 Skill 工具插件。 */
export const toolSkillPluginDefinition = {
  id: 'tool-skill', version: '1.0.0', description: '将当前 Agent 的 Skill 服务连接到工具', plugin: toolSkillPlugin,
}
