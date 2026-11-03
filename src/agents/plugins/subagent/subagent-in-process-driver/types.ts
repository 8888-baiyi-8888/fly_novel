import type { SubagentRun, SubagentRunId, SubagentStartRequest } from '@fly-novel/subagent'

/** Driver 执行一次任务所需的 Agent 能力。 */
export interface InProcessAgent {
  /** 执行原始任务文本；任务或基础设施失败时拒绝。 */
  run(input: { prompt: string }): Promise<{ content: string }>
  /** 请求取消当前任务，不等待任务结束。 */
  cancel(): void
}

/** 创建成功后交给 Driver 的 Agent 及其所属创建方的释放入口。 */
export interface InProcessAgentHandle {
  /** 创建方分配的运行标识，须满足 SubagentRun 的唯一性约定。 */
  readonly id: SubagentRunId
  readonly agent: InProcessAgent
  /** 释放 Agent 和创建方持有的登记；重复调用应等待同一次清理。 */
  dispose(): Promise<void>
}

/**
 * 建立一个可独立运行的 Agent。创建方决定创建参数与初始上下文；
 * 如果创建失败，创建方在拒绝前负责回滚未交付的资源；回滚失败时使用
 * SubagentStartupCleanupError 同时报告启动原因和清理错误。
 * 返回句柄后，Driver 负责其释放。
 */
export type InProcessAgentCreator = (request: SubagentStartRequest) => Promise<InProcessAgentHandle>

/**
 * 建立并运行一次子任务的 Driver 契约。
 * @param request 父 Agent、任务原文和取消信号。
 * @param create 创建并持有子 Agent 的可信调用方提供的能力。
 * @returns 已交付的运行句柄，不等待任务完成。
 * @throws 启动失败或交付前取消时拒绝；未交付的资源须在拒绝前清理。
 */
export type InProcessRunDriver = (request: SubagentStartRequest, create: InProcessAgentCreator) => Promise<SubagentRun>
