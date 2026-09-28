import type { HookId, ThreadId } from '../types/identifiers.ts'
import type { Thread } from '../types/thread.ts'
import type { WeavePlan } from '../types/weave-plan.ts'

/**
 * 叙事线管理器（TimelineManager）确定性服务 —— 接口契约（章节级文档 §16.1）。
 * 当前仅落地签名与类型；行为实现（含 §7.3 交织门禁、§9.2 时点可达性）留待后续。
 */

/** 叙事线快照（推断：各线状态一览；实现时按真实消费方校准）。 */
export type ThreadSnapshot = Readonly<Record<ThreadId, Thread>>

export interface TimelineManager {
  snapshotFor(chapter: number): ThreadSnapshot
  /** 排程方案（§7.2）：含 §7.3 交织门禁与 blocked 理由。 */
  checkWeaveEligibility(chapter: number): WeavePlan
  /** 时点可达性（§9.2）：伏笔归属的叙事线是否已推进到能揭示真相的位置。 */
  canReach(threadId: ThreadId, hookId: HookId, chapter: number): boolean
  /** §11.4 时钟层推进（纯算术）。 */
  advanceAll(chapter: number): void
}
