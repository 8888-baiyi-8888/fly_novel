import type { Dispatch } from '../types/dispatch.ts'
import type { HookContext } from '../types/hook-context.ts'
import type { HookId } from '../types/identifiers.ts'
import type { HookRecord } from '../types/hook.ts'

/**
 * Dispatch 校验闸门（章节级文档 §5.3，确定性、先于落盘）。
 * 七条硬规则在 ①direct 产出 Dispatch 后立即执行，任何违反都拒绝入库：
 * 强制项必须覆盖、不得编造 hookId、不得 resolve 未埋设、开新须配套还旧、活跃上限、coreHook 不可 defer。
 * 本函数是纯函数：不读存储、不调 LLM，输入即判定。
 */

/** 校验所需的最小账本视图：规则 3/4/7 只依赖这些字段；真实账本（HookRecord 全集）可直接传入。 */
export type DispatchGateLedgerEntry = Pick<HookRecord, 'status' | 'startChapter' | 'lastAdvancedChapter' | 'coreHook'>

export interface DispatchGateInput {
  readonly dispatch: Dispatch
  /** 伏笔债务表视图（§4.4）：提供 mustResolve / mustAdvance 与本章预算。 */
  readonly context: HookContext
  /** 账本视图：hookId → 该伏笔的状态记录。 */
  readonly ledger: Readonly<Record<HookId, DispatchGateLedgerEntry>>
}

/** 七条规则的标识。 */
export type DispatchGateRule =
  | 'must-resolve-not-covered'
  | 'must-advance-not-covered'
  | 'unknown-hook'
  | 'resolve-unplanted'
  | 'open-without-payback'
  | 'open-when-disallowed'
  | 'defer-core-hook'

/** 单条违规：规则标识 + 人类可读说明（含涉及的 hookId，如有）。 */
export interface DispatchViolation {
  readonly rule: DispatchGateRule
  readonly message: string
  readonly hookIds?: readonly HookId[]
}

/** 校验结论：passed=false 时携带全部违规（聚合，不短路）。 */
export type DispatchGateVerdict =
  | { readonly passed: true }
  | { readonly passed: false; readonly violations: readonly DispatchViolation[] }

/**
 * 执行 §5.3 七条校验闸门，返回聚合判定。
 * 注意规则 5：文档原文「open 数 < resolve 数」按「开新不得多于还旧（open ≤ resolve）」实现——
 * 严格 < 会误拒「开一还一」（1<1 为假）与无伏笔操作的章节（0<0 为假）。
 */
export function validateDispatch(input: DispatchGateInput): DispatchGateVerdict {
  const { dispatch, context, ledger } = input
  const directives = dispatch.hookDirectives
  const violations: DispatchViolation[] = []

  // 规则 1：所有 mustResolve 是否都在 resolve 列表里？缺失 → 重新生成
  const missingResolve = context.mustResolve.filter((id) => !directives.resolve.some((r) => r.hookId === id))
  if (missingResolve.length > 0) {
    violations.push({
      rule: 'must-resolve-not-covered',
      message: `mustResolve 未进入 resolve 列表：${missingResolve.join('、')}`,
      hookIds: missingResolve,
    })
  }

  // 规则 2：所有 mustAdvance 是否都在 advance 列表里？缺失 → 重新生成
  const missingAdvance = context.mustAdvance.filter((id) => !directives.advance.some((a) => a.hookId === id))
  if (missingAdvance.length > 0) {
    violations.push({
      rule: 'must-advance-not-covered',
      message: `mustAdvance 未进入 advance 列表：${missingAdvance.join('、')}`,
      hookIds: missingAdvance,
    })
  }

  // 规则 3：resolve/advance 引用的 hookId 是否真实存在？编造 → 拒绝
  const referenced = [...directives.resolve.map((r) => r.hookId), ...directives.advance.map((a) => a.hookId)]
  const unknown = [...new Set(referenced.filter((id) => ledger[id] === undefined))]
  if (unknown.length > 0) {
    violations.push({
      rule: 'unknown-hook',
      message: `resolve/advance 引用了账本中不存在的 hookId：${unknown.join('、')}`,
      hookIds: unknown,
    })
  }

  // 规则 4：是否 resolve 了尚未埋设的（open 且 lastAdvanced=0 且 startChapter>本章）？→ 拒绝
  const unplanted = directives.resolve.filter((r) => {
    const entry = ledger[r.hookId]
    return entry !== undefined && entry.status === 'open' && entry.lastAdvancedChapter === 0 && entry.startChapter > dispatch.chapter
  })
  if (unplanted.length > 0) {
    violations.push({
      rule: 'resolve-unplanted',
      message: `resolve 了尚未埋设的伏笔：${unplanted.map((r) => r.hookId).join('、')}`,
      hookIds: unplanted.map((r) => r.hookId),
    })
  }

  // 规则 5：open 数 < resolve 数？违反「开新须配套还旧」→ 拒绝（open 不得多于 resolve）
  if (directives.open.length > directives.resolve.length) {
    violations.push({
      rule: 'open-without-payback',
      message: `open(${directives.open.length}) 多于 resolve(${directives.resolve.length})：开新须配套还旧`,
    })
  }

  // 规则 6：budget.openAllowed === false 时是否仍含 open？违反活跃上限 → 拒绝
  if (!context.budget.openAllowed && directives.open.length > 0) {
    violations.push({
      rule: 'open-when-disallowed',
      message: `budget.openAllowed=false 时仍含 ${directives.open.length} 个 open：违反活跃上限`,
    })
  }

  // 规则 7：defer 的 hookId 是否命中 coreHook？coreHook 不可 defer → 拒绝
  const coreDeferred = directives.defer.filter((x) => ledger[x.hookId]?.coreHook === true)
  if (coreDeferred.length > 0) {
    violations.push({
      rule: 'defer-core-hook',
      message: `coreHook 不可 defer：${coreDeferred.map((x) => x.hookId).join('、')}`,
      hookIds: coreDeferred.map((x) => x.hookId),
    })
  }

  return violations.length === 0 ? { passed: true } : { passed: false, violations }
}
