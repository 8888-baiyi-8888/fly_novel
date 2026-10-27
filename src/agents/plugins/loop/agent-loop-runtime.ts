import type { Context } from '@deepseek-ai/cordis'
import type {
  AgentLoop,
  AgentLoopInput,
  AgentLoopResult,
  AgentPluginDefinition,
} from '../../core/contracts/agent.js'
import type { Session, TurnEndReason } from '@fly-novel/session'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentLoop: AgentLoop
  }
}

/** 从当前 Agent Context 获取 Session 服务，并协调 Turn 与 Step 生命周期。 */
export class AgentLoopRuntime implements AgentLoop {
  private readonly session: Session
  private turnNumber: number

  constructor(private readonly context: Context) {
    this.session = context.sessions.create()
    this.turnNumber = this.session.read().filter((event) => event.type === 'turn/start').length
  }

  /** 执行一个 Turn，并返回其 Step 结果。 */
  run(input: AgentLoopInput): Promise<AgentLoopResult> {
    return this.turn(input.prompt)
  }

  private async turn(prompt: string): Promise<AgentLoopResult> {
    const turn = this.turnNumber + 1
    this.session.append('turn/start', { turn })
    this.turnNumber = turn

    let reason: TurnEndReason = { kind: 'completed' }
    try {
      return await this.step({ turn, step: 1, prompt })
    } catch (error) {
      reason = { kind: 'error', message: 'Turn 执行失败' }
      throw error
    } finally {
      this.session.append('turn/end', { turn, reason })
    }
  }

  private async step(input: { readonly turn: number; readonly step: number; readonly prompt: string }): Promise<AgentLoopResult> {
    this.session.append('step/start', { turn: input.turn, step: input.step })
    try {
      return { content: input.prompt }
    } finally {
      this.session.append('step/end', { turn: input.turn, step: input.step })
    }
  }
}

/** 在当前 Agent Context 中注册由 Cordis Session 服务支持的 Loop。 */
export const agentLoopRuntimePlugin = Object.assign(function agentLoopRuntimePlugin(ctx: Context): void {
  ctx.provide('agentLoop', new AgentLoopRuntime(ctx))
}, { inject: ['sessions'], provide: 'agentLoop' })

/** Agent Loop Runtime 的 Harness 注册定义。 */
export const agentLoopRuntimePluginDefinition: AgentPluginDefinition = {
  id: 'agent-loop-runtime',
  version: '1.0.0',
  description: '通过当前 Agent Context 管理 Turn、Step 与 Session 生命周期',
  plugin: agentLoopRuntimePlugin,
}
