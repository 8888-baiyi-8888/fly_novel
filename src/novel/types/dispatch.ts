import type { CharacterName, ThreadId } from './identifiers.ts'
import type { Tier } from './character.ts'
import type { HookDirectives } from './hook-context.ts'

/** 出场角色在本章的戏份档位。 */
export type CastRole = 'main' | 'support' | 'cameo'

/** 叙事线在本章中的时段位置。 */
export type ThreadSlot = 'start' | 'middle' | 'end'

/** 出场角色条目（章节级文档 §5.2 Dispatch.castPlan）。 */
export interface CastPlanEntry {
  readonly name: CharacterName
  readonly tier: Tier
  readonly role: CastRole
  /** 本章他要做什么。 */
  readonly directive: string
  /** 仅 S 级：向角色 Agent 提问。 */
  readonly agentQuery?: string
  /** 该角色本章绝不能做的事。 */
  readonly hardLimits: readonly string[]
}

/** 叙事线排程条目（章节级文档 §5.2 Dispatch.threadPlan）。 */
export interface ThreadPlanEntry {
  readonly threadId: ThreadId
  readonly eventIds: readonly string[]
  readonly slot: ThreadSlot
}

/** 本章预算（章节级文档 §5.2 Dispatch.budget）。 */
export interface DispatchBudget {
  readonly scenes: number
  readonly chars: number
}

/**
 * 拍摄单（章节级文档 §5.2）：①direct 的产出，本章"拍什么、谁出场、伏笔怎么办"的唯一决策。
 * ②simulate / ③merge / ④write 都只围绕它展开；Merger 不得新增剧情。
 */
export interface Dispatch {
  readonly chapter: number
  /** ≤40 字，本章唯一目标。 */
  readonly goal: string
  readonly castPlan: readonly CastPlanEntry[]
  readonly threadPlan: readonly ThreadPlanEntry[]
  readonly hookDirectives: HookDirectives
  readonly styleNotes: readonly string[]
  readonly budget: DispatchBudget
}
