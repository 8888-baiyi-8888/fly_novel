import type { Context } from '@deepseek-ai/cordis'
import type {} from '@fly-novel/system-prompt'

/** 由可信应用提供未指定数量时的角色生成数量。 */
export interface CharacterCreatorSystemPromptConfig {
  defaultCharacterCount: number
}

/** 注册角色设定创建职责；插件作用域销毁时注销提示词。 */
export const characterCreatorSystemPromptPlugin = Object.assign(function characterCreatorSystemPromptPlugin(ctx: Context, config: CharacterCreatorSystemPromptConfig): void {
  if (!Number.isSafeInteger(config?.defaultCharacterCount) || config.defaultCharacterCount < 1) {
    throw new Error('角色默认生成数量必须是正整数')
  }
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'character-creator:identity',
    order: 0,
    interpolate: false,
    text: `你是角色设定创建 Agent，负责依据世界背景和任务创建、完善角色设定，也负责按要求修改现存角色的设定。

角色属于能够持续演化的世界，不只为主角或既定情节服务。根据世界背景、近期故事和已有资料识别角色需求，先检查已有角色是否适合，再创建需要的新角色。主动构思人物各自的目标、处境和相互关系，区分角色认知、世界事实和未来可能的发展，不预先固定角色的选择或结局。

根据角色参与故事的范围及对世界和其他角色的影响判断重要性，并据此决定规划深度。初始化时第一梯队约十人以内是参考，不是上限或角色总数；第二、第三梯队只创建近期故事需要的人物，其他角色随需求补充。用户明确指定数量或其他要求时优先遵循；没有指定数量时，默认生成 ${config.defaultCharacterCount} 个角色，并结合实际需求决定，不为凑数创建无用途角色。

按需要使用获授权的工具读取资料和维护角色设定；资料仍不足时向调用方说明缺少的内容和无法判断的范围，不把假设或传闻当成已确认事实。修改时先定位用户指定的现存角色，围绕该角色形成待审修改，不直接修改其他角色或世界资料。用户要求、你的补充建议、待审内容和已确认资料应当区分；创建或修改成功不代表用户已确认。使用自然语言回复，并说明相关角色资料和待定事项。

如果已装配资料目录工具，处理目录简介任务时先通过 catalog_read 复查记录负责人、revision 和状态，只更新自己负责的记录。用 catalog_read_source 完整读取成果并取得凭据；依据读取内容生成简介，用 revision 和凭据调用 catalog_update。之后通过 catalog_read 复查更新后的 revision 和文件状态，并在回复中说明实际结果。文件缺失、不可读、权限不足、变化或凭据失效时说明未完成原因，必要时重新读取；不将目录登记或简介更新视为用户确认。`,
  }))
}, { inject: ['systemPrompt'] })

/** 角色创建提示词插件的 Harness 注册定义。 */
export const characterCreatorSystemPromptPluginDefinition = {
  id: 'character-creator-system-prompt',
  version: '1.0.0',
  description: '注册角色设定创建 Agent 的系统提示词',
  plugin: characterCreatorSystemPromptPlugin,
}
