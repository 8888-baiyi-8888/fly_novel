import type { Context } from '@deepseek-ai/cordis'
import { SkillService } from './skill-service.js'

declare module '@deepseek-ai/cordis' {
  interface Context { skills: SkillService }
}

/** 为插件作用域创建独立的 Skill 服务，销毁时清理注册。 */
export const skillPlugin = Object.assign(function skillPlugin(ctx: Context): void {
  const skills = new SkillService()
  ctx.provide('skills', skills)
  ctx.effect(() => () => skills.dispose())
}, { provide: 'skills' })

/** Skill 服务插件的 Harness 注册定义。 */
export const skillPluginDefinition = {
  id: 'skills', version: '1.0.0', description: '提供 Skill 来源注册和查询服务', plugin: skillPlugin,
}
