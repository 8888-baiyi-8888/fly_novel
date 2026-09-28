import type { ApplyDeltaPureResult } from '../services/apply-delta.ts'
import type { HookLedger, TimelineManager, TruthOracle } from '../services/index.ts'
import type { BookConfig } from '../types/book-config.ts'
import type { CharacterCard, CharacterState } from '../types/character.ts'
import type { CharacterName, HookId } from '../types/identifiers.ts'
import type { HookRecord } from '../types/hook.ts'
import type { RuntimeDelta } from '../types/runtime-delta.ts'

/**
 * 书运行时（Book Runtime）：小说流交付给章节流的确定性状态面。
 * 章节流只依赖本接口，不依赖小说流的实现细节——小说流就绪后以真实服务实现替换
 * FakeBookRuntime 即可，节点与引擎零改动。
 * 组成：BookConfig + HookLedger（伏笔账本）+ TimelineManager（叙事时钟）+ TruthOracle（真相库）+ 角色卡。
 */
export interface BookRuntime {
  readonly config: BookConfig
  readonly ledger: HookLedger
  readonly timeline: TimelineManager
  readonly truth: TruthOracle
  readonly characters: readonly CharacterCard[]
  /** 角色运行时状态（每章 settle 后更新；stateChanges 合并目标）。 */
  readonly characterStates: Readonly<Record<CharacterName, CharacterState>>
  /** 账本全量只读视图（①direct 的 §5.3 闸门输入；全量 HookRecord 满足闸门视图 Pick 结构）。 */
  readonly ledgerView: Readonly<Record<HookId, HookRecord>>
  /**
   * ⑦settle 回写入口（§11.3 的纯函数部分）：六步校验 + 不可变合并 → 账本 / 真相 / 时钟 / 角色状态
   * 在同一调用内更新；rejected-batch 时任何状态不变（原子语义）。
   * 真实落盘（持久化 WorkflowStore）不在本接口范围。
   */
  settleChapter(chapter: number, delta: RuntimeDelta): ApplyDeltaPureResult
}
