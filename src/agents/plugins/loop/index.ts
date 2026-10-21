import type { Context } from '@deepseek-ai/cordis'
import type { AgentLoop, AgentPluginDefinition } from '../../core/contracts/agent.js'
export type { AgentLoop, AgentLoopInput, AgentLoopResult } from '../../core/contracts/agent.js'

export interface MockLoopConfig {
  prefix?: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentLoop: AgentLoop
  }
}

export const mockLoopPlugin = Object.assign(function mockLoopPlugin(
  ctx: Context,
  config: MockLoopConfig = {},
): void {
  const loop: AgentLoop = {
    async run(input) {
      return {
        content: `${config.prefix ?? '[MockLoop]'} ${input.prompt}`,
      }
    },
  }

  ctx.provide('agentLoop', loop)
}, { provide: 'agentLoop' })

/** mock Agent loop 的注册定义，由 Harness 启动入口统一装配。 */
export const mockLoopPluginDefinition: AgentPluginDefinition<MockLoopConfig> = {
  id: 'mock-loop',
  version: '1.0.0',
  description: '临时 Agent loop 插件',
  plugin: mockLoopPlugin,
  defaultConfig: {},
}
