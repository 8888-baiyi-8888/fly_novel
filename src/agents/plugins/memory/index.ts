import type { Context } from '@deepseek-ai/cordis'
import type { AgentPluginDefinition } from '../../core/contracts/agent.js'

export interface AgentMemory {
  get(key: string): unknown
  set(key: string, value: unknown): void
  delete(key: string): boolean
  clear(): void
}

export interface MockMemoryConfig {
  initial?: Record<string, unknown>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    memory: AgentMemory
  }
}

export const mockMemoryPlugin = Object.assign(function mockMemoryPlugin(
  ctx: Context,
  config: MockMemoryConfig = {},
): void {
  const values = new Map<string, unknown>(
    Object.entries(config.initial ?? {}),
  )

  const memory: AgentMemory = {
    get: (key) => values.get(key),
    set: (key, value) => void values.set(key, value),
    delete: (key) => values.delete(key),
    clear: () => values.clear(),
  }

  ctx.provide('memory', memory)
}, { provide: 'memory' })

/** mock memory 的注册定义，由 Harness 启动入口统一装配。 */
export const mockMemoryPluginDefinition: AgentPluginDefinition<MockMemoryConfig> = {
  id: 'mock-memory',
  version: '1.0.0',
  description: '临时 Agent memory 插件',
  plugin: mockMemoryPlugin,
  defaultConfig: {},
}
