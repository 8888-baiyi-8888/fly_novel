import type { CharacterName, HookId } from './identifiers.ts'

/** 场景类别。 */
export type SceneKind = 'main' | 'side' | 'transition'

/** 场景在章内的位置。 */
export type SceneSlot = 'start' | 'middle' | 'end'

/** 场景内伏笔操作（章节级文档 §7.4 SceneSheetScene.hookOps；无 defer——挂起决策只发生在 Director 层）。 */
export interface SceneHookOp {
  readonly hookId: HookId
  readonly op: 'open' | 'advance' | 'resolve' | 'mention'
  readonly how: string
  /** 回收呼应摘录。 */
  readonly echo?: string
}

/** 从角色模拟中取用的素材（章节级文档 §7.4 SceneSheetScene.material）。 */
export interface SceneMaterial {
  readonly lines: readonly string[]
  readonly actions: readonly string[]
  /** 该角色此刻的怀疑（用于信息差）。 */
  readonly suspects: readonly string[]
}

/** 拍摄单中的单个场景（章节级文档 §7.4 SceneSheet.scenes）。 */
export interface SceneSheetScene {
  readonly no: number
  readonly kind: SceneKind
  /** 视角角色。 */
  readonly pov: CharacterName
  readonly slot: SceneSlot
  readonly purpose: string
  /** 要落的内容。 */
  readonly beats: readonly string[]
  readonly cast: readonly CharacterName[]
  readonly material: SceneMaterial
  readonly hookOps: readonly SceneHookOp[]
  readonly budgetChars: number
  readonly emotion: string
}

/**
 * 线性拍摄单（章节级文档 §7.4）：③merge 的产出，④write 的输入。
 * Merger 只编排不创作：本结构只含来自 Dispatch / Simulation[] / WeavePlan 的素材，
 * 不含任何新剧情、新伏笔或角色决策（可追溯性是账本可靠性的地基）。
 */
export interface SceneSheet {
  /** 2-3 句：本章怎么拍。 */
  readonly writingPlan: string
  readonly scenes: readonly SceneSheetScene[]
  /** 转场技巧与节奏提醒。 */
  readonly weavingNotes: string
  /** 继承 Dispatch.hardLimits。 */
  readonly forbidden: readonly string[]
}
