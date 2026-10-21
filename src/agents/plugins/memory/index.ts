import type { Context } from '@deepseek-ai/cordis'

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
