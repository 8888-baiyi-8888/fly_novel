import type { Message } from '@fly-novel/llm'
import type { SessionEvent, SessionEventType, SessionLogOffset, SessionSeq } from '../types/index.ts'

/** 消息投影事件发生前的只读历史。 */
export interface SessionMessageProjectionContext {
  /** 按模型可见顺序排列的当前消息事件序号。 */
  nodes: readonly SessionSeq[]
  /** 连续事件窗口；候选序号及其之后的事件不作为已提交的输入。 */
  events: readonly SessionEvent[]
  /** 窗口中首个事件的绝对序号。 */
  baseSeq: SessionLogOffset
  /** 以原始事件序号为键的已有消息投影。 */
  messages: ReadonlyMap<SessionSeq, Message>
}

/** 对插件拥有的、改变已有消息内容的单个事件进行纯函数解释。 */
export interface SessionMessageProjection<T extends SessionEventType = SessionEventType> {
  /** 本定义解释的事件；在 SessionEventMap 中使用 @messageProjection 声明。 */
  type: T
  /**
   * 返回更新前校验完整的持久化决策。保留消息标识，发布不可变副本，不修改输入。
   * @param event - 尚未应用到所提供历史的候选事件。
   * @param context - 此决策之前的历史。
   * @returns 以原始序号为键的已变更当前消息。
   * @throws 持久化决策无法应用到此历史时抛错。
   */
  project(event: SessionEvent<T>, context: SessionMessageProjectionContext): ReadonlyMap<SessionSeq, Message>
}

/** 折叠会话消息视图时观察到的一次替换操作。 */
export interface SurfaceFoldReplacement {
  /** 替换此前消息视图范围的事件序号。 */
  seq: SessionSeq
  /** 声明的替换范围起始序号，包含该位置。 */
  start: SessionSeq
  /** 声明的替换范围结束序号，包含该位置。 */
  end: SessionSeq
  /** 操作实际移除的视图条目，按视图顺序排列。 */
  shadowedSeqs: SessionSeq[]
}

/** 重放会话日志中消息视图操作的完整结果。 */
export interface SurfaceFoldResult {
  /** 按模型可见顺序排列的当前消息视图事件序号。 */
  nodes: SessionSeq[]
  /** 按事件顺序排列的替换操作。 */
  replacements: SurfaceFoldReplacement[]
  /** 以原始事件序号为键的不可变投影消息。 */
  projectedMessages: ReadonlyMap<SessionSeq, Message>
}

/** 可生成消息的会话事件的只读实时投影。 */
export interface SessionSurface {
  /** 按模型可见顺序排列的当前消息视图事件序号。 */
  readonly nodes: readonly SessionSeq[]
  /** 已提交的位置替换操作的单调递增计数。 */
  readonly replaceGeneration: number
  /** 已提交替换操作和插件消息变更的单调递增计数。 */
  readonly contentGeneration: number
}
