import type { Context } from '@deepseek-ai/cordis'
import type { AgentLoop } from '@fly-novel/agent-loop'
import type { AgentPluginDefinition } from '../core/contracts/agent.js'

export interface MockLoopConfig {
  prefix?: string
}

/** 用于测试与无模型运行的回显 Loop。 */
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
    cancel() {},
    async dispose() {},
  }

  ctx.provide('agentLoop', loop)
}, { provide: 'agentLoop' })

/** mock Agent loop 的 Harness 注册定义。 */
export const mockLoopPluginDefinition: AgentPluginDefinition<MockLoopConfig> = {
  id: 'mock-loop',
  version: '1.0.0',
  description: '临时 Agent loop 插件',
  plugin: mockLoopPlugin,
  defaultConfig: {},
}
