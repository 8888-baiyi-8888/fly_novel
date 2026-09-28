import type { HookId } from './identifiers.ts'
import type { HookTiming } from './hook.ts'

/** 开新伏笔指令（章节级文档 §4.4 HookDirectives.open）。 */
export interface HookOpenDirective {
  readonly type: string
  readonly description: string
  readonly payoffTiming: HookTiming
  readonly expectedPayoff: string
  /** 埋设原文摘录，回收时呼应（echo）用。 */
  readonly echoHint: string
}

/**
 * 导演对伏笔的处置指令（章节级文档 §4.4）：Dispatch 中 Director 的伏笔决策。
 * 落盘前必须通过 §5.3 校验闸门：mustResolve/mustAdvance 全覆盖、不编造 hookId、
 * open 数 < resolve 数、openAllowed=false 时不得含 open、coreHook 不得 defer。
 */
export interface HookDirectives {
  readonly open: readonly HookOpenDirective[]
  readonly advance: ReadonlyArray<{ readonly hookId: HookId; readonly how: string; readonly to: 'progressing' }>
  /** echoFrom = notes 摘录。 */
  readonly resolve: ReadonlyArray<{ readonly hookId: HookId; readonly how: string; readonly echoFrom: string }>
  readonly defer: ReadonlyArray<{ readonly hookId: HookId; readonly reason: string; readonly untilChapter: number }>
  /** ★ 仅提及，不更新 lastAdvancedChapter。 */
  readonly mention: readonly HookId[]
}

/** 单条伏笔的压力读数（章节级文档 §4.4 HookContext.pressure）。 */
export interface HookPressure {
  readonly score: number
  readonly label: string
  readonly age: number
  readonly dormancy: number
}

/** 本章伏笔预算（章节级文档 §4.4 HookContext.budget）。 */
export interface HookBudget {
  readonly activeCount: number
  readonly cap: number
  readonly openAllowed: boolean
}

/**
 * 伏笔债务表视图（章节级文档 §4.4）：HookLedger.viewForChapter(N) 的输出，①direct 的只读输入。
 * mustResolve / mustAdvance 为系统强制项，Director 无法绕过（§5.3 校验闸门保证）。
 */
export interface HookContext {
  readonly mustResolve: readonly HookId[]
  readonly mustAdvance: readonly HookId[]
  readonly canResolve: readonly HookId[]
  readonly canAdvance: readonly HookId[]
  readonly mustNotDefer: readonly HookId[]
  readonly pressure: Readonly<Record<HookId, HookPressure>>
  readonly staleDebt: readonly HookId[]
  readonly budget: HookBudget
}
