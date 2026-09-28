import type { HookId } from '../types/identifiers.ts'
import type { HookRecord, HookStatus, HookTiming, HookType } from '../types/hook.ts'
import { canTransitionHookStatus, HOOK_TYPES } from '../types/hook.ts'
import type { HookContext, HookPressure } from '../types/hook-context.ts'
import type { HookOp } from '../types/runtime-delta.ts'
import type { SceneSheet } from '../types/scene-sheet.ts'

/**
 * 伏笔账本（HookLedger）确定性服务 —— 纯函数先行部分。
 * 接口契约对齐章节级文档 §16.1；lifecycle（§4.3）、准入闸门（§10.4）、
 * 不可变合并（§11.2 ⑥）为纯函数，可直接测试；依赖存储/LLM 的方法留待实现。
 */

/** 书阶段：用全书进度而非绝对章数，保证 30 章的书和 300 章的书节奏一致。 */
export type HookPhase = 'opening' | 'middle' | 'late'

export function bookPhase(chapter: number, totalChapters: number): HookPhase {
  const p = chapter / totalChapters
  if (p >= 0.72) return 'late'
  if (p >= 0.33) return 'middle'
  return 'opening'
}

/** §4.2 档位：payoffTiming 决定该伏笔的全部生命周期参数。 */
export interface HookTimingProfile {
  /** 最早可回收（章龄）。 */
  readonly earliestResolveAge: number
  /** 陈旧线（休眠章数）。 */
  readonly staleDormancy: number
  /** 逾期线（章龄）。 */
  readonly overdueAge: number
  /** 最低书阶段。 */
  readonly minimumPhase: HookPhase
  /** 回收倾向（压力放大系数）。 */
  readonly resolveBias: number
}

export const HOOK_TIMING_PROFILES: Readonly<Record<HookTiming, HookTimingProfile>> = {
  immediate: { earliestResolveAge: 1, staleDormancy: 1, overdueAge: 3, minimumPhase: 'opening', resolveBias: 5 },
  'near-term': { earliestResolveAge: 1, staleDormancy: 2, overdueAge: 5, minimumPhase: 'opening', resolveBias: 4 },
  'mid-arc': { earliestResolveAge: 2, staleDormancy: 4, overdueAge: 8, minimumPhase: 'opening', resolveBias: 3 },
  'slow-burn': { earliestResolveAge: 4, staleDormancy: 5, overdueAge: 12, minimumPhase: 'middle', resolveBias: 2 },
  endgame: { earliestResolveAge: 6, staleDormancy: 6, overdueAge: 16, minimumPhase: 'late', resolveBias: 1 },
}

/** §4.3 单条伏笔的生命周期报告（纯算术，无副作用）。 */
export interface LifecycleReport {
  readonly age: number
  readonly dormancy: number
  readonly overdue: boolean
  readonly stale: boolean
  readonly readyToResolve: boolean
  readonly advancePressure: number
  readonly resolvePressure: number
}

/**
 * §4.3 压力算法：给定当前章、书总章数、一条伏笔记录，纯算术推导。
 * 两个压力分决定 Director 收到什么指令（≥40 MUST、≥30 SHOULD）。
 */
const PHASE_LEVEL: Readonly<Record<HookPhase, number>> = { opening: 0, middle: 1, late: 2 }

export function lifecycle(h: HookRecord, chapter: number, totalChapters: number): LifecycleReport {
  const profile = HOOK_TIMING_PROFILES[h.payoffTiming]
  const phase = bookPhase(chapter, totalChapters)

  const age = chapter - h.startChapter
  const lastTouch = Math.max(h.startChapter, h.lastAdvancedChapter)
  const dormancy = chapter - lastTouch

  const phaseReady = PHASE_LEVEL[phase] >= PHASE_LEVEL[profile.minimumPhase]
  const recentlyTouched = dormancy <= 1
  const progressing = h.status === 'progressing'

  const overdue = phaseReady && age >= profile.overdueAge
  const stale = phaseReady && (dormancy >= profile.staleDormancy || (overdue && !(progressing || recentlyTouched)))
  const readyToResolve =
    phaseReady &&
    (h.payoffTiming !== 'endgame' || phase === 'late') &&
    age >= profile.earliestResolveAge &&
    (progressing || recentlyTouched)

  return {
    age,
    dormancy,
    overdue,
    stale,
    readyToResolve,
    advancePressure: age + dormancy + (stale ? 8 : 0) + (overdue ? 6 : 0),
    resolvePressure: readyToResolve
      ? profile.resolveBias * 10 + (progressing ? 5 : 0) + Math.min(12, dormancy * 2) + (overdue ? 10 : 0)
      : 0,
  }
}

/** 伏笔种子候选（§10.4）：Settler 自动扫描与建书阶段共用同一套准入闸门。 */
export interface NewHookCandidate {
  readonly type: string
  readonly expectedPayoff?: string
  readonly notes?: string
}

export type AdmissionDecision =
  | { readonly passed: true }
  | { readonly passed: false; readonly reasons: readonly string[] }

/**
 * §10.4 准入两条硬规则：type 非空 + expectedPayoff/notes 至少一个非空。
 * 不是所有"暗示"都值得记账——垃圾伏笔会让账本膨胀到不可维护。
 */
export function admitHookCandidate(candidate: NewHookCandidate): AdmissionDecision {
  const reasons: string[] = []
  if (candidate.type.trim() === '') reasons.push('type 必须非空')
  if ((candidate.expectedPayoff ?? '').trim() === '' && (candidate.notes ?? '').trim() === '') {
    reasons.push('expectedPayoff 与 notes 至少一个非空')
  }
  return reasons.length === 0 ? { passed: true } : { passed: false, reasons }
}

/** §11.2 ⑥ 不可变合并的输入：已通过六步校验①-⑤的干净操作 + 账本 + 本章。 */
export interface MergeHookOpsInput {
  readonly ledger: Readonly<Record<HookId, HookRecord>>
  readonly ops: readonly HookOp[]
  readonly chapter: number
}

/** §11.2 ⑥ 合并输出：新账本（不可变）+ 本章被处理过的伏笔 + 合并期跳过的操作说明。 */
export interface MergeHookOpsOutput {
  readonly ledger: Readonly<Record<HookId, HookRecord>>
  /** 本章被处理过的 hookId（mention 只登记不计数，供 audit/health 使用）。 */
  readonly touched: readonly HookId[]
  /** 合并期被跳过的操作（如违反状态迁移、coreHook 被 defer）。 */
  readonly skipped: readonly { readonly opIndex: number; readonly reason: string }[]
}

/** 生成下一个伏笔编号（H 后接三位数递增）。 */
function nextHookId(ledger: Readonly<Record<HookId, HookRecord>>): HookId {
  let max = 0
  for (const key of Object.keys(ledger)) {
    const m = /^H(\d+)$/.exec(key)
    if (m !== null) max = Math.max(max, Number(m[1]))
  }
  return `H${String(max + 1).padStart(3, '0')}` as HookId
}

/**
 * §11.2 ⑥ 不可变合并：把通过校验的操作应用到账本副本。
 * - advance：lastAdvancedChapter = max(旧值, 本章)（防回退；Settler 上报值仅作参考，防幻觉写未来）；
 *   advancedCount = max(旧+1, 上报值)（计数并防回退）；status 沿 open→progressing 前进。
 * - resolve：status → resolved；open：新增记录（notes=echoHint）；defer：status → deferred（coreHook 拒绝）；
 * - mention：只登记 touched，不动任何计数字段。
 */
export function mergeHookOps(input: MergeHookOpsInput): MergeHookOpsOutput {
  const next: Record<string, HookRecord> = { ...input.ledger }
  const touched: HookId[] = []
  const skipped: { opIndex: number; reason: string }[] = []

  input.ops.forEach((op, index) => {
    switch (op.op) {
      case 'open': {
        const hookType = HOOK_TYPES.find((t) => t === op.type)
        if (hookType === undefined) {
          skipped.push({ opIndex: index, reason: `open.type 不在类型词表内：${op.type}` })
          break
        }
        const hookId = nextHookId(next as Readonly<Record<HookId, HookRecord>>)
        next[hookId] = {
          hookId,
          startChapter: input.chapter,
          type: hookType,
          status: 'open',
          lastAdvancedChapter: 0,
          advancedCount: 0,
          expectedPayoff: op.expectedPayoff,
          payoffTiming: op.payoffTiming,
          notes: op.echoHint === '' ? undefined : op.echoHint,
        }
        break
      }
      case 'advance': {
        const record = next[op.hookId]
        if (record === undefined) { skipped.push({ opIndex: index, reason: `advance 引用不存在的 hookId ${op.hookId}` }); break }
        // advance 是"推进"而非状态迁移：open→progressing 与 progressing 持续推进均合法；
        // resolved（终态）与 deferred（须先恢复）不可推进。
        if (record.status !== 'open' && record.status !== 'progressing') {
          skipped.push({ opIndex: index, reason: `advance 只允许 open/progressing 状态：${record.status}` })
          break
        }
        next[op.hookId] = {
          ...record,
          status: 'progressing',
          lastAdvancedChapter: Math.max(record.lastAdvancedChapter, input.chapter),
          advancedCount: Math.max(record.advancedCount + 1, op.advancedCount),
        }
        break
      }
      case 'resolve': {
        const record = next[op.hookId]
        if (record === undefined) { skipped.push({ opIndex: index, reason: `resolve 引用不存在的 hookId ${op.hookId}` }); break }
        if (!canTransitionHookStatus(record.status, 'resolved')) {
          skipped.push({ opIndex: index, reason: `resolve 违反状态迁移：${record.status} → resolved` })
          break
        }
        next[op.hookId] = { ...record, status: 'resolved' }
        break
      }
      case 'defer': {
        const record = next[op.hookId]
        if (record === undefined) { skipped.push({ opIndex: index, reason: `defer 引用不存在的 hookId ${op.hookId}` }); break }
        if (record.coreHook === true) {
          skipped.push({ opIndex: index, reason: `coreHook ${op.hookId} 不得 defer` })
          break
        }
        if (!canTransitionHookStatus(record.status, 'deferred')) {
          skipped.push({ opIndex: index, reason: `defer 违反状态迁移：${record.status} → deferred` })
          break
        }
        next[op.hookId] = { ...record, status: 'deferred' }
        break
      }
      case 'mention': {
        touched.push(op.hookId)
        break
      }
    }
  })

  return { ledger: next as Readonly<Record<HookId, HookRecord>>, touched, skipped }
}

/**
 * viewForChapter 纯函数的输入选项。
 */
export interface ViewForChapterOptions {
  /** 书总章数（bookPhase 需要；来自 BookConfig.targetChapters）。 */
  readonly totalChapters: number
  /** 活跃伏笔上限（budget.cap）。默认 12（§4.4 示例值；真实值应由平台参数配置）。 */
  readonly cap?: number
}

/**
 * 压力标签优先级：MUST_RESOLVE > MUST_ADVANCE > SHOULD_RESOLVE > OK。
 * MUST 类（强制）先于 SHOULD 类（建议）；SHOULD_RESOLVE 与 MUST_ADVANCE 并存时取 MUST_ADVANCE。
 */
function pressureLabel(report: LifecycleReport): string {
  if (report.resolvePressure >= 40) return 'MUST_RESOLVE'
  if (report.advancePressure >= 8 || (report.stale && !report.readyToResolve)) return 'MUST_ADVANCE'
  if (report.resolvePressure >= 30) return 'SHOULD_RESOLVE'
  return 'OK'
}

/**
 * §4.4 债务表视图（HookLedger.viewForChapter 的纯函数版；①direct 的只读输入，与 §5.3 闸门闭环）。
 * 指令判定（§4.3）：resolvePressure ≥ 40 → mustResolve；advancePressure ≥ 8 或 stale 且未 ready →
 * mustAdvance；readyToResolve 且未达 MUST → canResolve；未达 MUST_ADVANCE 的可推进 → canAdvance。
 * mustNotDefer = coreHook ∪ mustResolve（§3.5 / §4.3"不可 defer"）。
 * resolved（已结清）与 deferred（主动挂起）不发任何指令、不进 pressure/staleDebt；
 * activeCount 统计未 resolved 的条数（deferred 仍占预算，§4.6）。
 */
export function viewForChapter(
  ledger: Readonly<Record<HookId, HookRecord>>,
  chapter: number,
  options: ViewForChapterOptions,
): HookContext {
  const totalChapters = options.totalChapters
  const cap = options.cap ?? 12

  const mustResolve: HookId[] = []
  const mustAdvance: HookId[] = []
  const canResolve: HookId[] = []
  const canAdvance: HookId[] = []
  const mustNotDefer: HookId[] = []
  const staleDebt: HookId[] = []
  const pressure: Record<string, HookPressure> = {}
  let activeCount = 0

  for (const hookId of Object.keys(ledger) as HookId[]) {
    const record = ledger[hookId]
    if (record.status !== 'resolved') activeCount += 1
    if (record.status === 'resolved' || record.status === 'deferred') continue

    const report = lifecycle(record, chapter, totalChapters)
    const isMustResolve = report.resolvePressure >= 40
    const isMustAdvance = report.advancePressure >= 8 || (report.stale && !report.readyToResolve)

    pressure[hookId] = {
      score: Math.max(report.advancePressure, report.resolvePressure),
      label: pressureLabel(report),
      age: report.age,
      dormancy: report.dormancy,
    }

    if (isMustResolve) mustResolve.push(hookId)
    else if (report.readyToResolve) canResolve.push(hookId)

    if (isMustAdvance) mustAdvance.push(hookId)
    else if (record.status === 'open' || record.status === 'progressing') canAdvance.push(hookId)

    if (record.coreHook === true) mustNotDefer.push(hookId)
    if (report.stale) staleDebt.push(hookId)
  }
  // §4.3 MUST_RESOLVE 不可 defer：追加到 mustNotDefer
  for (const hookId of mustResolve) {
    if (!mustNotDefer.includes(hookId)) mustNotDefer.push(hookId)
  }

  return {
    mustResolve,
    mustAdvance,
    canResolve,
    canAdvance,
    mustNotDefer,
    pressure: pressure as Readonly<Record<HookId, HookPressure>>,
    staleDebt,
    budget: { activeCount, cap, openAllowed: activeCount < cap },
  }
}

/**
 * HookLedger 接口契约（章节级文档 §16.1）。
 * 纯函数部分（lifecycle / admit / applyDelta 校验与合并 / viewForChapter）已先行实现；
 * audit / health 依赖 SceneSheet 审计逻辑与健康度报表，留待后续。
 */
export interface HookLedger {
  viewForChapter(chapter: number): HookContext
  admit(candidate: NewHookCandidate): AdmissionDecision
  applyDelta(chapter: number, delta: readonly HookOp[]): Promise<unknown>
  audit(chapter: number, sceneSheet: SceneSheet, draft: string): Promise<unknown>
  health(chapter: number, targetChapters: number): unknown
  lifecycle(hookId: HookId, chapter: number): LifecycleReport
}
