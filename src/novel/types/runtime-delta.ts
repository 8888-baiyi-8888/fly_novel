import type { CharacterName, HookId } from './identifiers.ts'
import type { CharacterState } from './character.ts'
import type { Fact } from './fact.ts'
import type { HookTiming } from './hook.ts'

/**
 * 伏笔操作 delta（章节级文档 §11.1）：Settler 从正文反推的五类伏笔操作。
 * 合并规则见 §11.2 六步校验：mention 只进"本章是否被处理过"，不动任何计数字段；
 * lastAdvancedChapter 取 max 防回退；status 只能沿 open→progressing→resolved 前进。
 */
export type HookOp =
  | { readonly op: 'open'; readonly type: string; readonly description: string; readonly payoffTiming: HookTiming; readonly expectedPayoff: string; readonly echoHint: string }
  | { readonly op: 'advance'; readonly hookId: HookId; readonly how: string; readonly to: 'progressing'; readonly lastAdvancedChapter: number; readonly advancedCount: number }
  | { readonly op: 'resolve'; readonly hookId: HookId; readonly how: string; readonly echoFrom: string }
  | { readonly op: 'defer'; readonly hookId: HookId; readonly reason: string; readonly untilChapter: number }
  | { readonly op: 'mention'; readonly hookId: HookId }

/** 待写入的新事实：factId / validFromChapter / sourceChapter 由 TruthOracle 在事务内补全。 */
export type FactDelta = Pick<Fact, 'subject' | 'subjectType' | 'predicate' | 'object' | 'knownBy'>

/** 角色状态可变更字段；knowns 由 TruthOracle 派生，不在 settle 直接写入之列。 */
export type CharacterStateChange = Partial<Pick<CharacterState, 'location' | 'goal' | 'emotion' | 'suspects' | 'inventory' | 'bonds'>>

/**
 * 结算 delta（章节级文档 §11.1；结构按三类 delta 推导：facts / hookOps / stateChanges）。
 * ⑦settle 的唯一输出；经六步校验后单事务原子落盘（§11.3），不存在"状态已推进、正文没落盘"的半完成态。
 */
export interface RuntimeDelta {
  readonly facts: readonly FactDelta[]
  readonly hookOps: readonly HookOp[]
  /** 按角色名的状态变更。 */
  readonly stateChanges: Readonly<Record<CharacterName, CharacterStateChange>>
}
