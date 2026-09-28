import type { HookId } from '../types/identifiers.ts'
import type { HookRecord } from '../types/hook.ts'
import type { HookOp } from '../types/runtime-delta.ts'
import { validateApplyDelta } from '../gates/apply-delta-gate.ts'
import type { ApplyDeltaViolation, ApplyDeltaWarning } from '../gates/apply-delta-gate.ts'
import { mergeHookOps } from './hook-ledger.ts'

/**
 * §11.2 applyDelta 的确定性编排入口（存储层接入前的最后一环）：
 * 六步校验链 ①-⑤（gates/apply-delta-gate.ts）→ ⑥ 不可变合并（hook-ledger.ts 的 mergeHookOps）。
 * 纯函数、无副作用：返回新账本（不可变）或 rejected-batch（原账本引用，状态不变）。
 * 依赖方向：apply-delta → gates → hook-ledger，单向无环。
 * §11.3 原子落盘（facts + hookOps + stateChanges 单事务）属真实 WorkflowStore，不在本纯函数范围。
 */

export interface ApplyDeltaPureInput {
  /** 本章（③ readyToResolve 与 ⑥ 合并用）。 */
  readonly chapter: number
  /** 书总章数 BookConfig.targetChapters（③ readyToResolve 用）。 */
  readonly totalChapters: number
  readonly ledger: Readonly<Record<HookId, HookRecord>>
  /** Settler 产出的伏笔操作 delta。 */
  readonly ops: readonly HookOp[]
  /** 本章时间线可达、可 resolve 的 hookId（TimelineManager.canReach 判定后传入；缺省全部可达）。 */
  readonly resolvableAt?: ReadonlySet<HookId>
}

export type ApplyDeltaPureResult =
  | {
    readonly kind: 'rejected-batch'
    readonly rule: 'schema' | 'unknown-hook'
    readonly violations: readonly ApplyDeltaViolation[]
    /** 校验失败：原账本引用原样返回，状态不变。 */
    readonly ledger: Readonly<Record<HookId, HookRecord>>
  }
  | {
    readonly kind: 'applied'
    /** 合并后的新账本（不可变；原账本未被修改）。 */
    readonly ledger: Readonly<Record<HookId, HookRecord>>
    /** ③ 降级与 ④⑤ 拒绝的登记（非致命）。 */
    readonly warnings: readonly ApplyDeltaWarning[]
    /** 本章被处理过的 hookId（mention 登记）。 */
    readonly touched: readonly HookId[]
    /** 合并期被跳过的操作（违反状态迁移、coreHook defer、词表外 type 等）。 */
    readonly skipped: readonly { readonly opIndex: number; readonly reason: string }[]
  }

export function applyDeltaPure(input: ApplyDeltaPureInput): ApplyDeltaPureResult {
  const verdict = validateApplyDelta(input)
  if (verdict.kind === 'rejected-batch') {
    return { kind: 'rejected-batch', rule: verdict.rule, violations: verdict.violations, ledger: input.ledger }
  }
  const merged = mergeHookOps({ ledger: input.ledger, ops: verdict.ops, chapter: input.chapter })
  return {
    kind: 'applied',
    ledger: merged.ledger,
    warnings: verdict.warnings,
    touched: merged.touched,
    skipped: merged.skipped,
  }
}
