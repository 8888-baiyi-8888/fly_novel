import type { Context } from '@deepseek-ai/cordis'
import type {} from '@fly-novel/tools'
import type { CharacterStore } from './store.js'
import type { CharacterRelationshipStore } from './relationship-store.js'
import { createCharacterTools, createCharacterInitializationTools } from './character-tools.js'
import { createCharacterRelationshipTools } from './relationship-tools.js'

/** 可信应用持有存储及解析器；工具插件不负责关闭它们。 */
export interface CharacterToolsPluginConfig {
  store: CharacterStore
  initialization?: true
  relationship?: { store: CharacterRelationshipStore; worldId: string; resolvePerson(id: string, signal: AbortSignal): Promise<{ id: string; worldId: string; name: string } | null> }
}

/** 在当前 Agent 作用域注册人物工具；作用域释放时注销。 */
export const characterToolsPlugin = Object.assign(function characterToolsPlugin(ctx: Context, config: CharacterToolsPluginConfig): void {
  if (!ctx.tools.agent) throw new Error('人物工具需要 Agent 身份')
  ctx.effect(() => {
    const disposers: (() => void)[] = []
    try {
      const tools = [...createCharacterTools(config.store), ...(config.initialization ? createCharacterInitializationTools(config.store) : []),
        ...(config.relationship ? createCharacterRelationshipTools(config.relationship.store, config.relationship) : [])]
      for (const tool of tools) disposers.push(ctx.tools.register(tool))
    } catch (error) { for (const dispose of disposers.reverse()) dispose(); throw error }
    return () => { for (const dispose of disposers.reverse()) dispose() }
  })
}, { inject: ['tools'] })

export const characterToolsPluginDefinition = { id: 'character-tools', version: '1.0.0', description: '注册可信人物资料和关系工具', plugin: characterToolsPlugin }
