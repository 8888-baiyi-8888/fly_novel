import { FiberState, type Context } from '@deepseek-ai/cordis'
import type {
  AgentLoop,
  AgentLoopInput,
  AgentLoopResult,
} from './types.js'
import type { Session, TurnEndReason } from '@fly-novel/session'
import { createAssistantMessage, createSystemMessage, createUserMessage, LlmError } from '@fly-novel/llm'
import type { ContentBlock, GenerateOptions } from '@fly-novel/llm'
import { renderPrompt } from '@fly-novel/system-prompt'
import type {} from '@fly-novel/tools'
import type {} from '@fly-novel/session-persistence'
import { recoverToolCall } from './tool-call-recovery.js'

export interface AgentLoopRuntimeConfig {
  readonly provider: string
  readonly model: string
  /** 工具执行的授权工作目录；使用工具时必须提供。 */
  readonly workingDirectory?: string
  /** 一个 Turn 中最多执行的模型 Step 数，默认 10。 */
  readonly maxSteps?: number
  /** 新建持久化 Session 的 ID。 */
  readonly sessionId?: string
  /** 要恢复的持久化 Session ID。 */
  readonly resumeSessionId?: string
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
  readonly abort: AbortController
}

/** 从当前 Agent Context 获取 Session，并协调 Turn 与 Step 生命周期。 */
export class AgentLoopRuntime implements AgentLoop {
  private readonly session: Session
  private readonly maxSteps: number
  private turnNumber: number
  private readonly pendingTurns: PendingTurn[] = []
  private phase:
    | { kind: 'idle' }
    | { kind: 'reserved'; prompt: string }
    | { kind: 'running'; turn: RunningTurn } = { kind: 'idle' }
  private driving = false
  private disposed = false
  private driverPromise: Promise<void> = Promise.resolve()

  constructor(private readonly context: Context, private readonly config: AgentLoopRuntimeConfig, session?: Session) {
    this.maxSteps = config.maxSteps === undefined ? 10 : config.maxSteps
    if (!Number.isSafeInteger(this.maxSteps) || this.maxSteps < 1) throw new Error('maxSteps 必须是正整数')
    this.session = session ?? context.sessions.create()
    this.turnNumber = this.session.read().reduce((latest, event) => event.type === 'turn/start' ? Math.max(latest, event.data.turn) : latest, 0)
  }

  /** 执行一个 Turn，并返回其 Step 结果。 */
  run(input: AgentLoopInput): Promise<AgentLoopResult> {
    if (this.disposed) return Promise.reject(new LlmError('Agent Loop 已销毁', 'ABORTED'))
    return new Promise((resolve, reject) => {
      this.pendingTurns.push({ prompt: input.prompt, resolve, reject })
      this.startDriver()
    })
  }

  /** 取消当前 Turn，并拒绝尚未开始的排队调用。 */
  cancel(): void {
    this.abort({ kind: 'user' })
  }

  /** 中止运行、拒绝排队输入，并等待活动 Turn 完成清理。 */
  async dispose(): Promise<void> {
    if (this.disposed) return this.driverPromise
    this.disposed = true
    this.abort({ kind: 'disposed' })
    await this.driverPromise
  }

  private abort(reason: { readonly kind: 'user' | 'disposed' }): void {
    const error = new LlmError(
      reason.kind === 'disposed' ? 'Agent Loop 已销毁' : 'Agent Loop 已取消',
      'ABORTED',
    )
    if (this.phase.kind === 'running') this.phase.turn.abort.abort(reason)
    for (const pending of this.pendingTurns.splice(0)) pending.reject(error)
  }

  private startDriver(): void {
    if (this.driving || this.disposed) return
    this.driving = true
    this.driverPromise = this.kick().finally(() => {
      this.driving = false
      if (this.pendingTurns.length > 0 && !this.disposed) this.startDriver()
    })
  }

  private async kick(): Promise<void> {
    while (this.pendingTurns.length > 0 && !this.disposed) {
      const pending = this.pendingTurns.shift()
      if (!pending) continue
      try {
        this.phase = { kind: 'reserved', prompt: pending.prompt }
        pending.resolve(await this.turn())
      } catch (error) {
        pending.reject(error)
      }
    }
  }

  private async turn(): Promise<AgentLoopResult> {
    if (this.phase.kind !== 'reserved') throw new Error('Turn 执行时没有已接收的输入')
    const { prompt } = this.phase
    const turn = this.turnNumber + 1
    this.session.append('turn/start', { turn })
    this.turnNumber = turn
    const abort = new AbortController()
    this.phase = { kind: 'running', turn: { prompt, turn, step: 1, abort } }

    let reason: TurnEndReason = { kind: 'completed' }
    try {
      while (true) {
        const result = await this.step()
        if (result !== undefined) return result
        if (this.phase.kind !== 'running') throw new Error('Step 完成时没有活动 Turn')
        if (this.phase.turn.step >= this.maxSteps) {
          reason = { kind: 'max-steps', maxSteps: this.maxSteps }
          throw new LlmError('Agent Loop 达到最大 Step 数', 'MAX_STEPS')
        }
        this.phase = { kind: 'running', turn: { ...this.phase.turn, step: this.phase.turn.step + 1 } }
      }
    } catch (error) {
      reason = abort.signal.aborted
        ? { kind: 'aborted', reason: abort.signal.reason.kind }
        : reason.kind === 'max-steps'
          ? reason
        : { kind: 'error', message: 'Turn 执行失败' }
      throw error
    } finally {
      try {
        this.session.append('turn/end', { turn, reason })
      } finally {
        this.phase = { kind: 'idle' }
      }
    }
  }

  private async step(): Promise<AgentLoopResult | undefined> {
    if (this.phase.kind !== 'running') throw new Error('Step 执行时没有活动 Turn')
    const { turn, step, abort } = this.phase.turn
    this.session.append('step/start', { turn, step })
    try {
      if (abort.signal.aborted) throw new LlmError('Agent Loop 已取消', 'ABORTED')
      const systemPrompt = renderPrompt(this.context.systemPrompt.assemble())
      const previousSystemPrompt = this.session.deriveMessages().some(({ role }) => role === 'system')
      if (systemPrompt.length > 0 || previousSystemPrompt) {
        this.session.append('system/message', {
          turn,
          step,
          message: createSystemMessage(systemPrompt, 'system-prompt'),
        })
      }
      if (step === 1) {
        this.session.append('user/message', createUserMessage({
          source: { kind: 'user' },
          content: [{ type: 'text', text: this.phase.turn.prompt }],
        }))
      }
      const request = this.buildRequest(abort.signal)
      const content: ContentBlock[] = []
      for await (const chunk of this.context.llm.stream(request)) {
        if (abort.signal.aborted) throw new LlmError('Agent Loop 已取消', 'ABORTED')
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
            case 'tool-calls': {
              const tools = this.context.get('tools')
              if (!tools) throw new LlmError('当前 Agent 未装配工具服务', 'UNSUPPORTED_TOOL_CALLS')
              const calls = content.filter((block) => block.type === 'tool-call')
              if (calls.length === 0 || new Set(calls.map(call => call.id)).size !== calls.length) {
                throw new LlmError('工具调用为空或调用 ID 重复', 'INVALID_RESPONSE')
              }
              if (!this.config.workingDirectory) throw new Error('工具调用需要配置授权工作目录')
              const message = createAssistantMessage({
                content,
                source: { provider: this.config.provider, model: this.config.model,
                  ...(chunk.replayState === undefined ? {} : { replayState: chunk.replayState }) },
              })
              this.session.append('assistant/message', { turn, step, message })
              try {
                const result = await tools.execute({ calls, signal: abort.signal, workingDirectory: this.config.workingDirectory,
                  log: { session: this.session, turn, step } })
                if (result.results.length !== calls.length ||
                    result.results.some((outcome, index) => outcome.callId !== calls[index]?.id)) {
                  throw new Error('工具结果与调用 ID 不匹配')
                }
                if (abort.signal.aborted) throw new LlmError('Agent Loop 已取消', 'ABORTED')
                return undefined
              } catch (error) {
                try {
                  for (const call of calls) recoverToolCall(this.session, turn, step, call)
                } catch (recoveryError) {
                  throw new AggregateError([error, recoveryError], '工具调用失败且无法记录恢复结果')
                }
                throw error
              }
            }
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

  private buildRequest(signal: AbortSignal): GenerateOptions {
    if (this.phase.kind !== 'running') throw new Error('构建模型请求时没有活动 Turn')
    const tools = this.context.get('tools')?.schemas()
    if (tools && tools.length > 0 && !this.config.workingDirectory) {
      throw new Error('工具调用需要配置授权工作目录')
    }
    return {
      provider: this.config.provider,
      model: this.config.model,
      messages: this.session.deriveMessages(),
      ...(tools && tools.length > 0 ? { tools } : {}),
      signal,
    }
  }
}

/** 声明 Session、SystemPrompt 与 LLM 服务依赖，并在当前 Context 注册 Loop。 */
export const agentLoopRuntimePlugin = Object.assign(async function agentLoopRuntimePlugin(
  ctx: Context,
  config: AgentLoopRuntimeConfig,
): Promise<void> {
  if (!config || typeof config.provider !== 'string' || !config.provider.trim() ||
      typeof config.model !== 'string' || !config.model.trim() ||
      (config.workingDirectory !== undefined && (typeof config.workingDirectory !== 'string' || !config.workingDirectory.trim()))) {
    throw new Error('Agent Loop 插件需要有效的 provider 和 model 配置')
  }
  if (config.sessionId !== undefined && (typeof config.sessionId !== 'string' || !config.sessionId.trim() || config.sessionId !== config.sessionId.trim())) throw new Error('sessionId 必须非空且不能包含首尾空白')
  if (config.resumeSessionId !== undefined && (typeof config.resumeSessionId !== 'string' || !config.resumeSessionId.trim() || config.resumeSessionId !== config.resumeSessionId.trim())) throw new Error('resumeSessionId 必须非空且不能包含首尾空白')
  if (config.sessionId !== undefined && config.resumeSessionId !== undefined) throw new Error('sessionId 与 resumeSessionId 不能同时指定')
  if (config.maxSteps !== undefined && (!Number.isSafeInteger(config.maxSteps) || config.maxSteps < 1)) throw new Error('maxSteps 必须是正整数')
  let session: Session | undefined
  if (config.sessionId !== undefined || config.resumeSessionId !== undefined) {
    const persistence = ctx.get('sessionPersistence')
    if (!persistence) throw new Error('未配置 Session 持久化后端')
    const handle = config.resumeSessionId !== undefined
      ? await persistence.open(config.resumeSessionId, 'write')
      : await persistence.create({ id: config.sessionId!, createdAt: new Date().toISOString() })
    try {
      const seed = config.resumeSessionId === undefined ? [] : (await handle.read()).events
      if ([FiberState.UNLOADING, FiberState.DISPOSED, FiberState.FAILED].includes(ctx.fiber.state)) throw new Error('Agent Loop 初始化期间已销毁')
      session = ctx.sessions.create(handle.id, { seed, createdAt: new Date(handle.header.createdAt) })
    } catch (error) {
      try { await handle.close() } catch (cleanup) { throw new AggregateError([error, cleanup], 'Session 初始化与句柄清理失败') }
      throw error
    }
  }
  const runtime = new AgentLoopRuntime(ctx, config, session)
  ctx.provide('agentLoop', runtime)
  ctx.effect(() => () => runtime.dispose())
}, { inject: ['sessions', 'systemPrompt', 'llm'], provide: 'agentLoop' })

/** Agent Loop Runtime 的 Harness 注册定义。 */
export const agentLoopRuntimePluginDefinition = {
  id: 'agent-loop-runtime',
  version: '1.0.0',
  description: '通过当前 Agent Context 管理 Turn、Step、Session 与一次 LLM 请求',
  plugin: agentLoopRuntimePlugin,
  defaultConfig: { provider: '', model: '' },
}
