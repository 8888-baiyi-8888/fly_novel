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

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentLoop: AgentLoop
  }
}
