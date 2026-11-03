/** 用于区分一次委派运行与 Agent 身份；标识由 Provider 分配。 */
export type SubagentRunId = string & { readonly __subagentRunId: unique symbol }

/** 将 Provider 分配的非空标识转换为运行标识。 */
export function subagentRunId(id: string): SubagentRunId {
  if (!id.trim()) throw new Error('Subagent 运行标识不能为空')
  return id as SubagentRunId
}

/** 父 Agent 的最小身份视图；调用方传入实际 Agent 实例。 */
export interface SubagentParent {
  readonly info: { readonly identity: { readonly id: string } }
}

/** 一次委派的父 Agent、任务原文及取消信号。 */
export interface SubagentStartRequest {
  readonly parent: SubagentParent
  readonly prompt: string
  /** 发布前取消启动并回滚；发布后取消该运行的剩余工作。 */
  readonly signal: AbortSignal
}

/** 任务终态；error 的 output 可以是部分结果。 */
export interface SubagentResult {
  readonly output: string
  readonly stopReason: 'completed' | 'error' | 'aborted'
}

/** 已发布的一次运行；调用方负责处理 result 并最终调用 dispose。 */
export interface SubagentRun {
  /** Provider 分配的运行标识；须在父 Agent 范围内与其他 Provider 的运行标识也不重复。 */
  readonly id: SubagentRunId
  /** 任务失败作为结果返回；无法表达为任务终态的基础设施故障可拒绝。 */
  readonly result: Promise<SubagentResult>
  /** 取消剩余工作并等待资源释放；可重复调用。 */
  dispose(): Promise<void>
}

/** 实现具体启动；同一个 Provider 的不同运行必须相互独立。 */
export interface SubagentProvider {
  readonly name: string
  /**
   * 建立一次运行并在发布后返回句柄，不等待任务完成。
   * @param request 父 Agent、任务及取消信号。
   * @returns 已发布运行的句柄，发布后所有权转移给调用方。
   * @throws 启动失败时清理未发布资源后拒绝。
   */
  start(request: SubagentStartRequest): Promise<SubagentRun>
}
