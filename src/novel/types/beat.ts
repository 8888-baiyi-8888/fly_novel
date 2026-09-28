import type { CharacterName, HookId, ThreadId } from './identifiers.ts'

/** 章节奏档位。 */
export type Pacing = '铺垫' | '上升' | '紧张' | '释放' | '舒缓'

/** 节拍板中一名角色的出场动作。 */
export interface BeatCharacter {
  readonly name: CharacterName
  readonly action: string
}

/**
 * 节拍板条目（全书章级蓝图，文档 §3.3）。
 * 由 Director 在建书阶段生成，章节级 ①direct 读取作为默认计划。
 * `hookIntentions` / `plannedPayoffOf` 是规划意图，不是账本债务本身。
 */
export interface Beat {
  readonly chapter: number
  readonly title: string
  /** 本章唯一大事，≤60 字。 */
  readonly mainBeat: string
  readonly characters: readonly BeatCharacter[]
  /** 主归属叙事线。 */
  readonly threadId: ThreadId
  readonly pacing: Pacing
  /** 情绪弧线，如 "憋屈→暗燃"。 */
  readonly emotionalArc: string
  /** 规划期的伏笔意图（人写的提示，非账本本身）。 */
  readonly hookIntentions: readonly string[]
  /** 本章预期回收哪些伏笔（Director 后续可覆盖）。 */
  readonly plannedPayoffOf: readonly HookId[]
}
