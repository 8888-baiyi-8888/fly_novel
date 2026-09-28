import type { CharacterName, EventId, ThreadId } from './identifiers.ts'

/** 支线插入位（章节级文档 §7.2）：无 middle——禁止打断主线高潮。 */
export type SideInsertSlot = 'start' | 'end'

/** 支线插入条目（章节级文档 §7.2 WeavePlan.sideInserts）。 */
export interface WeaveSideInsert {
  readonly threadId: ThreadId
  readonly eventIds: readonly EventId[]
  readonly slot: SideInsertSlot
  /** 与主线共享的角色，用作转场锚点。 */
  readonly castOverlap: readonly CharacterName[]
}

/** 想插但不能插的支线，附理由（章节级文档 §7.2 WeavePlan.blocked）。 */
export interface WeaveBlocked {
  readonly threadId: ThreadId
  readonly reason: string
}

/**
 * 交织排程方案（章节级文档 §7.2）：Timeline Manager 产出，经 §7.3 五道确定性门禁后才生成。
 * 只排程不创作，是 ③merge 的输入之一；每章至多 1 段支线插入。
 */
export interface WeavePlan {
  /** 本章主线要推进的 eventId 列表。 */
  readonly mainEvents: readonly EventId[]
  readonly sideInserts: readonly WeaveSideInsert[]
  readonly blocked: readonly WeaveBlocked[]
}
