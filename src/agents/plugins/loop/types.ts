export interface AgentLoopInput {
  /** 本次 Turn 的用户输入文本。 */
  prompt: string
}

export interface AgentLoopResult {
  /** 成功完成的 Turn 返回给调用方的助手文本。 */
  content: string
}

/**
 * Agent Loop 插件提供的执行服务契约。
 *
 * 每次 run 调用执行一个 Turn；成功时返回该 Turn 的助手文本，失败时拒绝并传播错误。
 */
export interface AgentLoop {
  run(input: AgentLoopInput): Promise<AgentLoopResult>
  cancel(): void
  dispose(): Promise<void>
}

/** 标准 Loop 可选提供的只读 Fork 历史能力。 */
export interface ForkHistorySource {
  /** 返回最后一个已结束轮次之前的独立事件快照；不支持的历史会抛错。 */
  snapshotForkHistory(): readonly SessionEvent[]
}

/** 每个模型 Step 前提供额外上下文；失败时阻止发送请求。 */
export interface ModelStepContext {
  prepare(options: { readonly workingDirectory: string | undefined; readonly signal: AbortSignal }): Promise<string>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentLoop: AgentLoop
    modelStepContext: ModelStepContext
  }
}
import type { SessionEvent } from '@fly-novel/session'
