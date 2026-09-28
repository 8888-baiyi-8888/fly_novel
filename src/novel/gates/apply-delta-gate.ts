import type { HookId } from '../types/identifiers.ts'
import type { HookRecord } from '../types/hook.ts'
import { HOOK_TYPES } from '../types/hook.ts'
import type { HookOp } from '../types/runtime-delta.ts'
import { HOOK_TIMING_PROFILES, lifecycle } from '../services/hook-ledger.ts'

/**
 * §11.2 六步校验链（校验部分 ①-⑤）：Settler 产出 hookOps delta 后、合并入账本前的
 * 确定性闸门。①schema / ②ID 失败 → 整批拒绝（状态不变）；③ 降级 / ④⑤ 拒绝 → 单条处理。
 * ⑥ 不可变合并见 services/hook-ledger.ts 的 mergeHookOps。
 */

export type ApplyDeltaRule =
  | 'schema-invalid'
  | 'unknown-hook'
  | 'resolve-not-ready'
  | 'resolve-dependency-blocked'
  | 'resolve-unreachable'

export interface ApplyDeltaViolation {
  readonly rule: ApplyDeltaRule
  /** 操作在输入 ops 中的下标（0 基）。 */
  readonly opIndex: number
  readonly hookId?: HookId
  readonly message: string
}

export interface ApplyDeltaInput {
  /** 本章（③ readyToResolve 与 ⑥ 合并用）。 */
  readonly chapter: number
  /** 书总章数 BookConfig.targetChapters（③ readyToResolve 用）。 */
  readonly totalChapters: number
  readonly ledger: Readonly<Record<HookId, HookRecord>>
  /** Settler 产出的伏笔操作 delta。 */
  readonly ops: readonly HookOp[]
  /**
   * 本章时间线可达、可 resolve 的 hookId（由 TimelineManager.canReach 判定后传入；
   * 缺省视为全部可达）。
   */
  readonly resolvableAt?: ReadonlySet<HookId>
}

/** 非致命登记：③ 降级为 advance / ④⑤ 拒绝该条 resolve。 */
export interface ApplyDeltaWarning {
  readonly rule: Exclude<ApplyDeltaRule, 'schema-invalid' | 'unknown-hook'>
  readonly opIndex: number
  readonly hookId: HookId
  readonly message: string
}

export type ApplyDeltaVerdict =
  | { readonly kind: 'rejected-batch'; readonly rule: 'schema' | 'unknown-hook'; readonly violations: readonly ApplyDeltaViolation[] }
  | {
    readonly kind: 'accepted'
    /** 通过校验、可进入 ⑥ 合并的操作（③ 已降级为 advance；④⑤ 拒绝的已剔除）。 */
    readonly ops: readonly HookOp[]
    /** ③ 降级与 ④⑤ 拒绝的登记（非致命，仅记录）。 */
    readonly warnings: readonly ApplyDeltaWarning[]
  }

const HOOK_TIMINGS = Object.keys(HOOK_TIMING_PROFILES)

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v)
}

/** ① schema 校验：字段类型、枚举、advancedCount ≥0 整数。返回违规说明或 undefined。 */
function schemaError(op: unknown): string | undefined {
  if (typeof op !== 'object' || op === null) return '操作不是对象'
  const record = op as Record<string, unknown>
  switch (record.op) {
    case 'open': {
      for (const key of ['type', 'description', 'expectedPayoff', 'echoHint']) {
        if (typeof record[key] !== 'string') return `open.${key} 必须是字符串`
      }
      if (typeof record.payoffTiming !== 'string' || !HOOK_TIMINGS.includes(record.payoffTiming)) return 'open.payoffTiming 必须是合法档位'
      if (typeof record.type === 'string' && !HOOK_TYPES.includes(record.type as never)) return `open.type 不在类型词表内：${record.type}`
      return undefined
    }
    case 'advance': {
      if (typeof record.hookId !== 'string') return 'advance.hookId 必须是字符串'
      if (typeof record.how !== 'string') return 'advance.how 必须是字符串'
      if (record.to !== 'progressing') return "advance.to 必须是 'progressing'"
      if (!isInt(record.lastAdvancedChapter) || (record.lastAdvancedChapter as number) < 0) return 'advance.lastAdvancedChapter 必须是非负整数'
      if (!isInt(record.advancedCount) || (record.advancedCount as number) < 0) return 'advance.advancedCount 必须是非负整数'
      return undefined
    }
    case 'resolve': {
      for (const key of ['hookId', 'how', 'echoFrom']) {
        if (typeof record[key] !== 'string') return `resolve.${key} 必须是字符串`
      }
      return undefined
    }
    case 'defer': {
      if (typeof record.hookId !== 'string') return 'defer.hookId 必须是字符串'
      if (typeof record.reason !== 'string') return 'defer.reason 必须是字符串'
      if (!isInt(record.untilChapter)) return 'defer.untilChapter 必须是整数'
      return undefined
    }
    case 'mention': {
      if (typeof record.hookId !== 'string') return 'mention.hookId 必须是字符串'
      return undefined
    }
    default:
      return `未知操作 op=${String((record as { op?: unknown }).op)}`
  }
}

/** ④ dependsOn 未全部 resolved？ */
function dependsOnBlocked(record: HookRecord, ledger: Readonly<Record<HookId, HookRecord>>): boolean {
  return (record.dependsOn ?? []).some((dep) => ledger[dep]?.status !== 'resolved')
}

/**
 * 执行 §11.2 六步校验链的 ①-⑤：
 * ① schema → 整批拒绝；② ID（resolve/advance/defer/mention 的 hookId 必须真实存在）→ 整批拒绝；
 * ③ resolve 需 readyToResolve（§4.3），否则降级为 advance（warning）；④ dependsOn 未全部 resolved → 拒绝该条；
 * ⑤ 时间线不可达 → 拒绝该条。通过者进入 ⑥ mergeHookOps。
 */
export function validateApplyDelta(input: ApplyDeltaInput): ApplyDeltaVerdict {
  const { chapter, totalChapters, ledger, ops, resolvableAt } = input

  // ① schema 校验：任一违规 → 整批丢弃，状态不变
  const schemaViolations: ApplyDeltaViolation[] = []
  ops.forEach((op, index) => {
    const error = schemaError(op)
    if (error !== undefined) schemaViolations.push({ rule: 'schema-invalid', opIndex: index, message: `第 ${index} 条：${error}` })
  })
  if (schemaViolations.length > 0) return { kind: 'rejected-batch', rule: 'schema', violations: schemaViolations }

  // ② ID 校验：resolve/advance/defer/mention 的 hookId 必须存在于账本 → 拒绝整批
  const idViolations: ApplyDeltaViolation[] = []
  ops.forEach((op, index) => {
    if (op.op === 'open') return
    if (ledger[op.hookId] === undefined) {
      idViolations.push({ rule: 'unknown-hook', opIndex: index, hookId: op.hookId, message: `引用账本中不存在的 hookId ${op.hookId}` })
    }
  })
  if (idViolations.length > 0) return { kind: 'rejected-batch', rule: 'unknown-hook', violations: idViolations }

  // ③④⑤ 逐条处理 resolve；其余操作原样通过
  const out: HookOp[] = []
  const warnings: ApplyDeltaWarning[] = []
  ops.forEach((op, index) => {
    if (op.op !== 'resolve') { out.push(op); return }
    const record = ledger[op.hookId]

    // ③ 语义校验：readyToResolve？否 → 降级为 advance（避免过早引爆）
    if (!lifecycle(record, chapter, totalChapters).readyToResolve) {
      warnings.push({
        rule: 'resolve-not-ready',
        opIndex: index,
        hookId: op.hookId,
        message: `resolve ${op.hookId} 时尚未 readyToResolve，降级为 advance`,
      })
      out.push({
        op: 'advance',
        hookId: op.hookId,
        how: op.how,
        to: 'progressing',
        lastAdvancedChapter: chapter,
        advancedCount: record.advancedCount + 1,
      })
      return
    }

    // ④ 依赖校验：dependsOn 未全部 resolved → 拒绝该条
    if (dependsOnBlocked(record, ledger)) {
      warnings.push({
        rule: 'resolve-dependency-blocked',
        opIndex: index,
        hookId: op.hookId,
        message: `resolve ${op.hookId} 时 dependsOn 前置未全部 resolved，拒绝`,
      })
      return
    }

    // ⑤ 时点校验：时间线不可达 → 拒绝该条
    if (resolvableAt !== undefined && !resolvableAt.has(op.hookId)) {
      warnings.push({
        rule: 'resolve-unreachable',
        opIndex: index,
        hookId: op.hookId,
        message: `resolve ${op.hookId} 时时间线不可达，拒绝`,
      })
      return
    }

    out.push(op)
  })

  return { kind: 'accepted', ops: out, warnings }
}
