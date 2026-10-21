import type { Context } from '@deepseek-ai/cordis'
import type { AgentLoop } from '../../core/contracts/agent.js'
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
