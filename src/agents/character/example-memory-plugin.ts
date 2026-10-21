import type { Context } from '@deepseek-ai/cordis'
import type { AgentPluginDefinition } from '../core/contracts/agent.js'

/** 角色专有插件示例服务；数据只保存在当前 Harness Agent 实例中。 */
export interface CharacterExampleMemory {
  remember(key: string, value: string): void
  recall(key: string): string | undefined
}

export interface CharacterExampleMemoryConfig {
  initial?: Record<string, string>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    characterExampleMemory: CharacterExampleMemory
  }
}

/** 演示角色模块如何提供独立服务；不接入现有 CharacterAgent 业务类。 */
export const characterExampleMemoryPlugin = Object.assign(function characterExampleMemoryPlugin(
  ctx: Context,
  config: CharacterExampleMemoryConfig = {},
): void {
  const values = new Map(Object.entries(config.initial ?? {}))
  const memory: CharacterExampleMemory = {
    remember(key, value) { values.set(key, value) },
    recall(key) { return values.get(key) },
  }
  ctx.provide('characterExampleMemory', memory)
}, { provide: 'characterExampleMemory' })

export const characterExampleMemoryPluginDefinition: AgentPluginDefinition<CharacterExampleMemoryConfig> = {
  id: 'character-example-memory',
  version: '1.0.0',
  description: '角色专有记忆插件样例',
  plugin: characterExampleMemoryPlugin,
  defaultConfig: {},
}
