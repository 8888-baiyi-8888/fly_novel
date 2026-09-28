import type { Fact } from '../types/fact.ts'
import type { FactDelta } from '../types/runtime-delta.ts'

/**
 * 真相服务器（TruthOracle）确定性服务 —— 接口契约（章节级文档 §16.1）。
 * 当前仅落地签名与类型；行为实现（§9 三态判别、retcon 区间截断、insertAll 事务）留待后续。
 */

/** 真相快照（推断：本章结束时的全部事实；实现时按真实消费方校准）。 */
export interface TruthSnapshot {
  readonly facts: readonly Fact[]
}

/** 事实校验结果（推断：valid=false 时携带违规说明；对应 §9.1 三态判别）。 */
export interface Validation {
  readonly valid: boolean
  readonly violations: readonly string[]
}

export interface TruthOracle {
  snapshot(chapter: number, subjects: readonly string[]): TruthSnapshot
  /** 某角色在给定章结束时的知识（knownBy 隔离点，§6.5 信息差）。 */
  knowledgeOf(character: string, chapter: number): readonly Fact[]
  validate(facts: readonly Fact[], chapter: number): Validation
  retcon(factId: string, newObject: string, chapter: number): void
  /** 事务内写入本章新事实：factId / validFrom / source / status 由实现补全。 */
  insertAll(chapter: number, facts: readonly FactDelta[]): void
}
