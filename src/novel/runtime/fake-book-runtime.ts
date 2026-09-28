import type { ApplyDeltaPureResult } from '../services/apply-delta.ts'
import { applyDeltaPure } from '../services/apply-delta.ts'
import { admitHookCandidate, lifecycle, viewForChapter } from '../services/hook-ledger.ts'
import type { AdmissionDecision, LifecycleReport, NewHookCandidate } from '../services/hook-ledger.ts'
import type { HookLedger, TimelineManager, TruthOracle } from '../services/index.ts'
import type { BookConfig } from '../types/book-config.ts'
import type { CharacterCard, CharacterState, Tier } from '../types/character.ts'
import type { CharacterName, FactId, HookId, ThreadId } from '../types/identifiers.ts'
import type { Fact, SubjectKind } from '../types/fact.ts'
import type { FactDelta } from '../types/runtime-delta.ts'
import type { HookContext } from '../types/hook-context.ts'
import type { HookOp } from '../types/runtime-delta.ts'
import type { HookRecord } from '../types/hook.ts'
import type { RuntimeDelta } from '../types/runtime-delta.ts'
import type { SceneSheet } from '../types/scene-sheet.ts'
import type { Thread } from '../types/thread.ts'
import type { Validation } from '../services/truth-oracle.ts'
import type { ThreadSnapshot } from '../services/timeline-manager.ts'
import type { WeavePlan } from '../types/weave-plan.ts'
import type { BookRuntime } from './book-runtime.ts'
import { DEFAULT_FIXTURE, type FakeBookRuntimeOptions } from './fixtures.ts'

/**
 * FakeBookRuntime：小说流交付的 Book Runtime 的内存模拟（确定性、无 I/O、无 LLM）。
 * 章节流开发不依赖小说流即可端到端运行；小说流就绪后以真实服务实现替换，节点与引擎零改动。
 * 实现标注"占位"的规则（canReach / advanceAll / retcon / checkWeaveEligibility）为最小可测简化，
 * 真实语义由小说流实现。
 */

const SUBJECT_KINDS: readonly SubjectKind[] = ['character', 'location', 'item', 'relationship', 'event', 'world']
const TIERS: readonly Tier[] = ['S', 'A', 'B']

function nextIdOf<T extends string>(prefix: string, existing: readonly string[]): T {
  let max = 0
  for (const key of existing) {
    const m = new RegExp(`^${prefix}(\\d+)$`).exec(key)
    if (m !== null) max = Math.max(max, Number(m[1]))
  }
  return `${prefix}${String(max + 1).padStart(3, '0')}` as T
}

class InMemoryHookLedger implements HookLedger {
  constructor(
    private readonly getRecord: () => Readonly<Record<HookId, HookRecord>>,
    private readonly setRecord: (next: Readonly<Record<HookId, HookRecord>>) => void,
    private readonly totalChapters: number,
    private readonly cap: number,
  ) {}

  viewForChapter(chapter: number): HookContext {
    return viewForChapter(this.getRecord(), chapter, { totalChapters: this.totalChapters, cap: this.cap })
  }

  admit(candidate: NewHookCandidate): AdmissionDecision {
    return admitHookCandidate(candidate)
  }

  /** 账本合并（可选路径）；settleChapter 直接走 applyDeltaPure（原子语义）。 */
  async applyDelta(chapter: number, delta: readonly HookOp[]): Promise<unknown> {
    const result = applyDeltaPure({ chapter, totalChapters: this.totalChapters, ledger: this.getRecord(), ops: delta })
    if (result.kind === 'applied') this.setRecord(result.ledger)
    return result
  }

  audit(_chapter: number, _sceneSheet: SceneSheet, _draft: string): never {
    throw new Error('FakeBookRuntime 未实现 audit（属小说级 HookLedger.audit）')
  }

  health(_chapter: number, _targetChapters: number): never {
    throw new Error('FakeBookRuntime 未实现 health（属小说级 HookLedger.health）')
  }

  lifecycle(hookId: HookId, chapter: number): LifecycleReport {
    const record = this.getRecord()[hookId]
    if (record === undefined) throw new Error(`lifecycle：账本中不存在 hookId ${hookId}`)
    return lifecycle(record, chapter, this.totalChapters)
  }
}

class InMemoryTimeline implements TimelineManager {
  constructor(
    private readonly getThreads: () => readonly Thread[],
    private readonly setThreads: (next: readonly Thread[]) => void,
    private readonly hookToThread: Readonly<Record<HookId, ThreadId>>,
  ) {}

  snapshotFor(_chapter: number): ThreadSnapshot {
    const out: Record<string, Thread> = {}
    for (const t of this.getThreads()) out[t.threadId] = t
    return out as ThreadSnapshot
  }

  /** 占位：active 线程按 priority 取主线事件；§7.3 五道门禁留待小说流实现。 */
  checkWeaveEligibility(_chapter: number): WeavePlan {
    const main = [...this.getThreads()].filter((t) => t.status === 'active').sort((a, b) => b.priority - a.priority)[0]
    return {
      mainEvents: main === undefined ? [] : main.eventChain.filter((e) => e.status === 'pending').map((e) => e.eventId),
      sideInserts: [],
      blocked: [],
    }
  }

  /**
   * 时点可达性（§9.2）占位规则：伏笔归属线非 dormant/abandoned 且线时钟已推进到本章
   * （settleChapter 在结算前判定、advanceAll 在结算后推进，故结算前视角的"本章可达"= syncPoint >= chapter-1；
   * 即上一章推进到上一章后，本章事件已可 resolve）。真实规则由小说流实现。
   */
  canReach(threadId: ThreadId, hookId: HookId, chapter: number): boolean {
    const owner = this.hookToThread[hookId]
    if (owner !== undefined && owner !== threadId) return false
    const thread = this.getThreads().find((t) => t.threadId === threadId)
    if (thread === undefined) return false
    return (thread.status === 'active' || thread.status === 'completed') && thread.syncPoint >= chapter - 1
  }

  /** 占位：active 线程时钟推进到本章；dormant 不动。 */
  advanceAll(chapter: number): void {
    this.setThreads(this.getThreads().map((t) => (t.status === 'active' ? { ...t, syncPoint: Math.max(t.syncPoint, chapter) } : t)))
  }
}

class InMemoryTruthOracle implements TruthOracle {
  constructor(
    private readonly getFacts: () => readonly Fact[],
    private readonly setFacts: (next: readonly Fact[]) => void,
  ) {}

  snapshot(chapter: number, subjects: readonly string[]): { readonly facts: readonly Fact[] } {
    return {
      facts: this.getFacts().filter(
        (f) => f.status === 'active' && f.validFromChapter <= chapter && (f.validUntilChapter === null || f.validUntilChapter > chapter) &&
          (subjects.length === 0 || subjects.includes(f.subject)),
      ),
    }
  }

  knowledgeOf(character: string, chapter: number): readonly Fact[] {
    return this.getFacts().filter(
      (f) => f.status === 'active' && f.validFromChapter <= chapter && (f.validUntilChapter === null || f.validUntilChapter > chapter) &&
        f.knownBy !== undefined && f.knownBy.includes(character as CharacterName),
    )
  }

  validate(facts: readonly Fact[], _chapter: number): Validation {
    const violations: string[] = []
    facts.forEach((f, i) => {
      if (f.subject.trim() === '') violations.push(`第 ${i} 条 subject 为空`)
      if (f.predicate.trim() === '') violations.push(`第 ${i} 条 predicate 为空`)
      if (f.object.trim() === '') violations.push(`第 ${i} 条 object 为空`)
      if (!SUBJECT_KINDS.includes(f.subjectType)) violations.push(`第 ${i} 条 subjectType 非法：${f.subjectType}`)
    })
    return { valid: violations.length === 0, violations }
  }

  /** 占位：旧事实标 retconned + validUntil=本章，新增修正事实（新 factId、从本章起真）。 */
  retcon(factId: string, newObject: string, chapter: number): void {
    const target = this.getFacts().find((f) => f.factId === factId)
    if (target === undefined) throw new Error(`retcon：不存在 factId ${factId}`)
    const rest = this.getFacts().filter((f) => f.factId !== factId)
    const retconned: Fact = { ...target, status: 'retconned', validUntilChapter: chapter }
    const replacement: Fact = {
      ...target,
      factId: nextIdOf<FactId>('F', this.getFacts().map((f) => f.factId)),
      object: newObject,
      validFromChapter: chapter,
      validUntilChapter: null,
      sourceChapter: chapter,
      status: 'active',
    }
    this.setFacts([...rest, retconned, replacement])
  }

  /** 事务内写入：补全 factId / validFrom / source / status；knownBy 保留。 */
  insertAll(chapter: number, deltas: readonly FactDelta[]): void {
    if (deltas.length === 0) return
    const existing = this.getFacts()
    let seq = 0
    for (const f of existing) {
      const m = /^F(\d+)$/.exec(f.factId)
      if (m !== null) seq = Math.max(seq, Number(m[1]))
    }
    const added: Fact[] = deltas.map((d) => {
      seq += 1
      return {
        factId: `F${String(seq).padStart(3, '0')}` as FactId,
        subject: d.subject,
        subjectType: d.subjectType,
        predicate: d.predicate,
        object: d.object,
        validFromChapter: chapter,
        validUntilChapter: null,
        sourceChapter: chapter,
        knownBy: d.knownBy,
        status: 'active',
      }
    })
    this.setFacts([...existing, ...added])
  }
}

/** 运行时状态快照（跨章持久化用；plain JSON 可序列化，含账本/线程/事实/角色状态）。 */
export interface FakeBookRuntimeSnapshot {
  readonly ledger: Readonly<Record<HookId, HookRecord>>
  readonly threads: readonly Thread[]
  readonly facts: readonly Fact[]
  readonly states: Readonly<Record<CharacterName, CharacterState>>
}

/** FakeBookRuntime 的公开视图：BookRuntime + 跨章状态存取（驱动与测试专用，小说流接入后仅需 BookRuntime）。 */
export interface FakeBookRuntime extends BookRuntime {
  /** 导出当前全部运行时状态（跨章断点）。 */
  snapshot(): FakeBookRuntimeSnapshot
  /** 用快照恢复状态（深拷贝，不保留对传入对象的引用）。 */
  restore(snapshot: FakeBookRuntimeSnapshot): void
}

class FakeBookRuntimeImpl implements FakeBookRuntime {
  readonly config: BookConfig
  readonly characters: readonly CharacterCard[]
  readonly cap: number
  readonly hookToThread: Readonly<Record<HookId, ThreadId>>

  private record: Readonly<Record<HookId, HookRecord>>
  private threads: readonly Thread[]
  private facts: readonly Fact[]
  private states: Readonly<Record<CharacterName, CharacterState>>

  readonly ledger: HookLedger
  readonly timeline: TimelineManager
  readonly truth: TruthOracle

  constructor(options: FakeBookRuntimeOptions) {
    const base = { ...DEFAULT_FIXTURE, ...options }
    this.config = base.config
    this.characters = base.characters
    this.cap = options.cap ?? 12
    this.hookToThread = base.hookToThread
    this.record = { ...base.ledger }
    this.threads = [...base.threads]
    this.facts = [...base.facts]
    this.states = { ...base.characterStates }

    this.ledger = new InMemoryHookLedger(
      () => this.record,
      (next) => { this.record = next },
      this.config.targetChapters,
      this.cap,
    )
    this.timeline = new InMemoryTimeline(
      () => this.threads,
      (next) => { this.threads = next },
      this.hookToThread,
    )
    this.truth = new InMemoryTruthOracle(
      () => this.facts,
      (next) => { this.facts = next },
    )
  }

  get ledgerView(): Readonly<Record<HookId, HookRecord>> {
    return this.record
  }

  get characterStates(): Readonly<Record<CharacterName, CharacterState>> {
    return this.states
  }

  snapshot(): FakeBookRuntimeSnapshot {
    return { ledger: this.record, threads: this.threads, facts: this.facts, states: this.states }
  }

  restore(snapshot: FakeBookRuntimeSnapshot): void {
    this.record = { ...snapshot.ledger }
    this.threads = snapshot.threads.map((t) => ({ ...t, eventChain: t.eventChain.map((e) => ({ ...e })) }))
    this.facts = snapshot.facts.map((f) => ({ ...f }))
    this.states = { ...snapshot.states }
  }

  /** ⑦settle 回写（§11.3 纯函数部分）：账本/真相/时钟/角色状态同批更新；rejected 时全不变。 */
  settleChapter(chapter: number, delta: RuntimeDelta): ApplyDeltaPureResult {
    // §9.2 时点可达：用结算前的时钟状态判定 resolve 可达集（推进发生在校验通过之后，本章不可依赖本章的推进）
    const resolvableAt = new Set<HookId>()
    for (const op of delta.hookOps) {
      if (op.op !== 'resolve') continue
      const owner = this.hookToThread[op.hookId]
      if (owner !== undefined && !this.timeline.canReach(owner, op.hookId, chapter)) continue
      resolvableAt.add(op.hookId)
    }
    const result = applyDeltaPure({ chapter, totalChapters: this.config.targetChapters, ledger: this.record, ops: delta.hookOps, resolvableAt })
    if (result.kind !== 'applied') return result
    this.record = { ...result.ledger }
    this.truth.insertAll(chapter, delta.facts)
    this.timeline.advanceAll(chapter)
    this.mergeStateChanges(chapter, delta)
    return result
  }

  private mergeStateChanges(_chapter: number, delta: RuntimeDelta): void {
    const names = Object.keys(delta.stateChanges) as CharacterName[]
    if (names.length === 0) return
    const next: Record<CharacterName, CharacterState> = { ...this.states }
    for (const name of names) {
      const change = delta.stateChanges[name]
      const current = next[name] ?? {
        name, location: '', goal: '', emotion: '', knows: [], suspects: [], inventory: [], bonds: {},
      }
      next[name] = {
        ...current,
        location: change.location ?? current.location,
        goal: change.goal ?? current.goal,
        emotion: change.emotion ?? current.emotion,
        suspects: change.suspects ?? current.suspects,
        inventory: change.inventory ?? current.inventory,
        bonds: change.bonds ?? current.bonds,
      }
    }
    this.states = next
  }
}

/** 构建一个确定性 FakeBookRuntime；options 缺省用 §7.7 默认 fixture。返回 FakeBookRuntime（含跨章快照能力）。 */
export function buildFakeBookRuntime(options: FakeBookRuntimeOptions = {}): FakeBookRuntime {
  return new FakeBookRuntimeImpl(options)
}
