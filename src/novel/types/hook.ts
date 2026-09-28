import type { HookId, ThreadId } from './identifiers.ts'

/** 伏笔债务状态。deferred=主动挂起（登记理由、可恢复）；coreHook 不得进入该状态。 */
export type HookStatus = 'open' | 'progressing' | 'deferred' | 'resolved'

/** 回收窗口档位，决定该伏笔的全部生命周期参数（档位表见章节级文档 §4.2）。 */
export type HookTiming = 'immediate' | 'near-term' | 'mid-arc' | 'slow-burn' | 'endgame'

/** 伏笔类型（文档 §3.5 给出的分类词表；2026-09-28 对接小说流 State₀ 词表后补入「事件」）。 */
export type HookType = '物件' | '身份' | '信息差' | '承诺' | '威胁' | '秘密' | '关系' | '能力' | '事件'

/** 类型词表常量：Settler 产出的 open.type 须落在此内（§10.4 准入与六步校验①共用）。 */
export const HOOK_TYPES: readonly HookType[] = ['物件', '身份', '信息差', '承诺', '威胁', '秘密', '关系', '能力', '事件']

/**
 * 伏笔记录（账本单元，文档 §3.5）。
 * 伏笔是作者对读者的债务：埋设=open，真实推进=advance，回收=resolve，
 * 仅提及不算推进（mention 不更新 lastAdvancedChapter）。
 */
export interface HookRecord {
  readonly hookId: HookId
  /** 埋设章。 */
  readonly startChapter: number
  readonly type: HookType
  readonly status: HookStatus
  /** 0 = 从未真实推进；只"提及"不更新此值。 */
  readonly lastAdvancedChapter: number
  /** 真实推进次数。 */
  readonly advancedCount: number
  /** 计划怎么还（必填，准入闸门用）。 */
  readonly expectedPayoff: string
  readonly payoffTiming: HookTiming
  /** 半衰期：超过则读者遗忘，压力上升。 */
  readonly halfLifeChapters?: number
  /** 主线级：不可 defer，必须 resolve。 */
  readonly coreHook?: boolean
  /** 前置伏笔：如 H032 依赖 H007 先 resolve。 */
  readonly dependsOn?: readonly HookId[]
  /** 预期回收卷。 */
  readonly paysOffInArc?: string
  /** 埋设原文摘录，用于回收时精确呼应（echo）。 */
  readonly notes?: string
}

/**
 * 伏笔状态迁移合法性（章节级文档 §11.2 六步校验第 ⑥ 条的模型化）：
 * 主链只能沿 open → progressing → resolved 前进；deferred 为挂起旁支，
 * 可恢复回 open/progressing；resolved 为终态。挂起状态不可直接回收，须先恢复。
 */
export function canTransitionHookStatus(from: HookStatus, to: HookStatus): boolean {
  switch (from) {
    case 'open':
      return to === 'progressing' || to === 'resolved' || to === 'deferred'
    case 'progressing':
      return to === 'resolved' || to === 'deferred'
    case 'deferred':
      return to === 'open' || to === 'progressing'
    case 'resolved':
      return false
  }
}
