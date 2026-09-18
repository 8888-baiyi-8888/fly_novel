/** 会话日志的增量消息视图；本入口同时导出离线折叠、消息投影与校验接口。 */

import type { Message } from '@fly-novel/llm'
import { SessionLogOffset, SessionSeq } from '../types/index.ts'
import type { SessionEvent, SessionSeqCursor } from '../types/index.ts'
import type { SessionMessageProjection, SessionSurface } from './types.ts'
import { deriveEventMessage } from './message.ts'
import { createFoldState, planSurfaceEvent, applySurfaceEvent, applySurfacePlan } from './fold.ts'
import type { SurfacePlan } from './fold.ts'

export type { SessionMessageProjectionContext, SessionMessageProjection, SurfaceFoldReplacement, SurfaceFoldResult, SessionSurface } from './types.ts'
export { isSurfaceEligibleType, isSurfaceEvent, isAppendSurfaceEvent, isReplacementSurfaceEvent, deriveEventMessage } from './message.ts'
export { validateSessionEventData } from '../validation/event-data.ts'
export { validateSurfaceMetadata } from './metadata.ts'
export { foldSurface } from './fold.ts'

/** 增量维护有序消息视图，并在追加边界执行校验。 */
export class SurfaceManager implements SessionSurface {
  /** 共享的状态转换状态；不保留替换历史。 */
  private _state = createFoldState()
  /** 最后处理的绝对序号。 */
  private _lastProcessedSeq: SessionSeqCursor
  /** 已由 validateNext 校验、等待日志精确接纳的候选事件。 */
  private _pendingPlan: { event: SessionEvent; expectedSeq: SessionSeq; plan: SurfacePlan | undefined } | undefined

  /**
   * @param log - 连续的完整日志或已加载的事件窗口。
   * @param baseSeq - 窗口首个事件的绝对序号。
   * @param projections - 借用的实时定义；移除已使用的定义会使后续读取失效。
   */
  constructor(
    private log: readonly SessionEvent[],
    private readonly baseSeq: SessionLogOffset = SessionLogOffset(0),
    private readonly projections: readonly SessionMessageProjection[] = [],
  ) {
    this._lastProcessedSeq = baseSeq === 0 ? -1 : SessionSeq(baseSeq - 1)
  }

  /**
   * 校验下一个候选事件，不修改已提交的消息视图。
   * @param event - 尚未进入日志的候选事件。
   */
  validateNext(event: SessionEvent): void {
    this._assertProjections()
    if (this._lastProcessedSeq < this.baseSeq + this.log.length - 1) this._processDelta()
    const expectedSeq = SessionSeq(this.baseSeq + this.log.length)
    this._pendingPlan = {
      event,
      expectedSeq,
      plan: planSurfaceEvent(this._state, event, expectedSeq, this.log, this.baseSeq, this.projections),
    }
  }

  /** 已折叠的位置替换操作的单调递增计数。 */
  get replaceGeneration(): number {
    this._assertProjections()
    if (this._lastProcessedSeq < this.baseSeq + this.log.length - 1) this._processDelta()
    return this._state.replaceGeneration
  }

  /** 对已有模型可见内容所提交变更的单调递增计数。 */
  get contentGeneration(): number {
    this._assertProjections()
    if (this._lastProcessedSeq < this.baseSeq + this.log.length - 1) this._processDelta()
    return this._state.contentGeneration
  }

  /**
   * 对单个消息应用所有已提交的消息投影。
   * @param event - 可生成消息的事件或仅日志事件。
   * @returns 不可变的投影消息；不生成消息时返回 null。
   */
  deriveEventMessage(event: SessionEvent): Message | null {
    this._assertProjections()
    if (this._lastProcessedSeq < this.baseSeq + this.log.length - 1) this._processDelta()
    return deriveEventMessage(event, this._state.projectedMessages)
  }

  /** 按模型可见顺序排列的消息视图事件序号。 */
  get nodes(): readonly SessionSeq[] {
    this._assertProjections()
    if (this._lastProcessedSeq < this.baseSeq + this.log.length - 1) this._processDelta()
    return this._state.nodes
  }

  /** 折叠上次访问后追加的事件。 */
  private _processDelta(): void {
    const tailSeq = this.baseSeq + this.log.length - 1
    for (let seq = this._lastProcessedSeq + 1; seq <= tailSeq; seq++) {
      const index = seq - this.baseSeq
      // oxlint-disable-next-line typescript/no-non-null-assertion -- 下标受循环条件约束
      const event = this.log[index]!
      const pending = this._pendingPlan
      if (pending?.event === event && pending.expectedSeq === seq) {
        applySurfacePlan(this._state, pending.plan)
      } else {
        applySurfaceEvent(this._state, event, SessionSeq(seq), this.log, this.baseSeq, this.projections)
      }
      if (pending !== undefined && pending.expectedSeq <= seq) this._pendingPlan = undefined
      this._lastProcessedSeq = SessionSeq(seq)
    }
  }

  /** 解释日志所用的定义失效后，不得继续使用缓存消息。 */
  private _assertProjections(): void {
    const candidate = this._pendingPlan
    const pending = candidate !== undefined && this.log[candidate.expectedSeq - this.baseSeq] === candidate.event
      ? candidate.plan : undefined
    const required = pending?.kind === 'project'
      ? [...this._state.projections, pending.projection]
      : this._state.projections
    for (const projection of required) {
      if (!this.projections.includes(projection)) {
        throw new Error(`会话消息投影 "${projection.type}" 已被移除或替换；请加载所属插件后恢复会话`)
      }
    }
  }
}
