import type { CharacterName, EventId, ThreadId } from './identifiers.ts'

/** 叙事线类别。 */
export type ThreadKind = 'main' | 'side' | 'flashback' | 'interlude'

/** 叙事线运行状态。 */
export type ThreadStatus = 'active' | 'dormant' | 'completed' | 'abandoned'

/** 事件链单元状态。 */
export type EventStatus = 'pending' | 'written' | 'settled'

/**
 * 事件链单元（文档 §3.6）。
 * 逻辑层（前置/汇合）管剧情依赖，调度层（叙事时钟）管章节排程。
 */
export interface ThreadEvent {
  readonly eventId: EventId
  readonly summary: string
  /** 归属章；null = 尚未排入具体章。 */
  readonly chapter: number | null
  /** 预计发生的卷（仅规划参考）。 */
  readonly volumeRange?: string
  /** 前置事件：发生本事件前必须完成的事件。 */
  readonly prerequisiteEventIds: readonly EventId[]
  /** 多线汇合事件：需要两条线各自前置都满足才触发。 */
  readonly isConvergencePoint?: boolean
  readonly status: EventStatus
}

/**
 * 叙事线（文档 §3.6）。同时具备逻辑层与调度层两层属性，一个实体，不是两套系统。
 * 调度层：syncPoint（该线自己的叙事时钟）+ speed（相对主线推进速率，side 默认 0.3）。
 */
export interface Thread {
  readonly threadId: ThreadId
  readonly kind: ThreadKind
  readonly title: string
  readonly status: ThreadStatus
  /** 冲突时高优先级占用本章篇幅。 */
  readonly priority: number
  readonly syncPoint: number
  readonly speed: number
  /** 按发生顺序的情节单元序列。 */
  readonly eventChain: readonly ThreadEvent[]
  readonly characters: readonly CharacterName[]
  readonly parentThreadId?: ThreadId
}
