import type { Context } from '@deepseek-ai/cordis'
import type {
  AgentLoop,
  AgentLoopInput,
  AgentLoopResult,
} from './types.js'
import type { Session, TurnEndReason } from '@fly-novel/session'
import { createAssistantMessage, createSystemMessage, createUserMessage, LlmError } from '@fly-novel/llm'
import type { ContentBlock, GenerateOptions } from '@fly-novel/llm'
import { renderPrompt } from '@fly-novel/system-prompt'

export interface AgentLoopRuntimeConfig {
  readonly provider: string
  readonly model: string
}

interface PendingTurn {
  readonly prompt: string
  readonly resolve: (result: AgentLoopResult) => void
  readonly reject: (error: unknown) => void
}

interface RunningTurn {
  readonly prompt: string
  readonly turn: number
  readonly step: number
}

/** 从当前 Agent Context 获取 Session，并协调 Turn 与 Step 生命周期。 */
export class AgentLoopRuntime implements AgentLoop {
  private readonly session: Session
  private turnNumber: number
  private readonly pendingTurns: PendingTurn[] = []
  private phase:
    | { kind: 'idle' }
    | { kind: 'reserved'; prompt: string }
    | { kind: 'running'; turn: RunningTurn } = { kind: 'idle' }
  private driving = false

  constructor(private readonly context: Context, private readonly config: AgentLoopRuntimeConfig) {
    this.session = context.sessions.create()
    this.turnNumber = this.session.read().filter((event) => event.type === 'turn/start').length
  }

  /** 执行一个 Turn，并返回其 Step 结果。 */
  run(input: AgentLoopInput): Promise<AgentLoopResult> {
    return new Promise((resolve, reject) => {
      this.pendingTurns.push({ prompt: input.prompt, resolve, reject })
      void this.kick()
    })
  }

  private async kick(): Promise<void> {
    if (this.driving) return
    this.driving = true
    try {
      while (this.pendingTurns.length > 0) {
        const pending = this.pendingTurns.shift()
        if (!pending) continue
        try {
          this.phase = { kind: 'reserved', prompt: pending.prompt }
          pending.resolve(await this.turn())
        } catch (error) {
          pending.reject(error)
        }
      }
    } finally {
      this.driving = false
      if (this.pendingTurns.length > 0) await this.kick()
    }
  }

  private async turn(): Promise<AgentLoopResult> {
    if (this.phase.kind !== 'reserved') throw new Error('Turn 执行时没有已接收的输入')
    const { prompt } = this.phase
    const turn = this.turnNumber + 1
    this.session.append('turn/start', { turn })
    this.turnNumber = turn
    this.phase = { kind: 'running', turn: { prompt, turn, step: 1 } }

    let reason: TurnEndReason = { kind: 'completed' }
    try {
      return await this.step()
    } catch (error) {
      reason = { kind: 'error', message: 'Turn 执行失败' }
      throw error
    } finally {
      try {
        this.session.append('turn/end', { turn, reason })
      } finally {
        this.phase = { kind: 'idle' }
      }
    }
  }

  private async step(): Promise<AgentLoopResult> {
    if (this.phase.kind !== 'running') throw new Error('Step 执行时没有活动 Turn')
    const { turn, step } = this.phase.turn
    this.session.append('step/start', { turn, step })
    try {
      const systemPrompt = renderPrompt(this.context.systemPrompt.assemble())
      const previousSystemPrompt = this.session.deriveMessages().some(({ role }) => role === 'system')
      if (systemPrompt.length > 0 || previousSystemPrompt) {
        this.session.append('system/message', {
          turn,
          step,
          message: createSystemMessage(systemPrompt, 'system-prompt'),
        })
      }
      this.session.append('user/message', createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: this.phase.turn.prompt }],
      }))
      const request = this.buildRequest()
      const content: ContentBlock[] = []
      for await (const chunk of this.context.llm.stream(request)) {
        if (chunk.type === 'finish') {
          switch (chunk.reason.kind) {
            case 'stop': {
              const message = createAssistantMessage({
                content,
                source: {
                  provider: this.config.provider,
                  model: this.config.model,
                  ...(chunk.replayState === undefined ? {} : { replayState: chunk.replayState }),
                },
              })
              this.session.append('assistant/message', { turn, step, message })
              return { content: message.content.flatMap((block) => block.type === 'text' ? [block.text] : []).join('') }
            }
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
        if (chunk.type === 'block-end') content.push(chunk.block)
      }
      throw new LlmError('LLM 响应流未包含结束块', 'INVALID_RESPONSE')
    } finally {
      this.session.append('step/end', { turn, step })
    }
  }

  private buildRequest(): GenerateOptions {
    if (this.phase.kind !== 'running') throw new Error('构建模型请求时没有活动 Turn')
    return {
      provider: this.config.provider,
      model: this.config.model,
      messages: this.session.deriveMessages(),
    }
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
