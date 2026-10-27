import type { Context } from '@deepseek-ai/cordis'
import type {
  AgentLoop,
  AgentLoopInput,
  AgentLoopResult,
} from './types.js'
import type { Session, TurnEndReason } from '@fly-novel/session'
import { randomUUID } from 'node:crypto'
import { freezeMessage, LlmError, type MessageId } from '@fly-novel/llm'
import type { GenerateOptions } from '@fly-novel/llm'

export interface AgentLoopRuntimeConfig {
  readonly provider: string
  readonly model: string
}

/** 从当前 Agent Context 获取 Session，并协调 Turn 与 Step 生命周期。 */
export class AgentLoopRuntime implements AgentLoop {
  private readonly session: Session
  private turnNumber: number

  constructor(private readonly context: Context, private readonly config: AgentLoopRuntimeConfig) {
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
      const request = this.buildRequest(input.prompt)
      let content = ''
      for await (const chunk of this.context.llm.stream(request)) {
        if (chunk.type === 'finish') {
          switch (chunk.reason.kind) {
            case 'stop':
              return { content }
            case 'error':
            case 'aborted':
              throw new LlmError(chunk.reason.failure.message, chunk.reason.failure.code, {
                status: chunk.reason.failure.status,
                providerRetryAfterMs: chunk.reason.failure.providerRetryAfterMs,
                requestId: chunk.reason.failure.requestId,
              })
            case 'tool-calls':
              throw new LlmError('当前 Agent Loop 尚不支持工具调用', 'UNSUPPORTED_TOOL_CALLS')
            case 'max-tokens':
              throw new LlmError('模型响应达到最大 token 数，未完成本次请求', 'MAX_TOKENS')
            default: {
              const exhaustive: never = chunk.reason
              throw new Error(`未处理的 LLM 结束原因: ${String(exhaustive)}`)
            }
          }
        }
        if (chunk.type === 'text-delta') content += chunk.text
      }
      throw new LlmError('LLM 响应流未包含结束块', 'INVALID_RESPONSE')
    } finally {
      this.session.append('step/end', { turn: input.turn, step: input.step })
    }
  }

  private buildRequest(prompt: string): GenerateOptions {
    const message = freezeMessage({
      id: randomUUID() as MessageId,
      role: 'user' as const,
      source: { kind: 'user' as const },
      content: [{ type: 'text' as const, text: prompt }],
    })
    const options: GenerateOptions = {
      provider: this.config.provider,
      model: this.config.model,
      messages: [message],
    }
    return options
  }
}

/** 声明 Session、SystemPrompt 与 LLM 服务依赖，并在当前 Context 注册 Loop。 */
export const agentLoopRuntimePlugin = Object.assign(function agentLoopRuntimePlugin(
  ctx: Context,
  config: AgentLoopRuntimeConfig,
): void {
  if (!config || typeof config.provider !== 'string' || !config.provider.trim() ||
      typeof config.model !== 'string' || !config.model.trim()) {
    throw new Error('Agent Loop 插件需要有效的 provider 和 model 配置')
  }
  ctx.provide('agentLoop', new AgentLoopRuntime(ctx, config))
}, { inject: ['sessions', 'systemPrompt', 'llm'], provide: 'agentLoop' })

/** Agent Loop Runtime 的 Harness 注册定义。 */
export const agentLoopRuntimePluginDefinition = {
  id: 'agent-loop-runtime',
  version: '1.0.0',
  description: '通过当前 Agent Context 管理 Turn、Step、Session 与一次 LLM 请求',
  plugin: agentLoopRuntimePlugin,
  defaultConfig: { provider: '', model: '' },
}
