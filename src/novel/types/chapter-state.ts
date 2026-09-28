import type { BookId } from './identifiers.ts'
import type { Dispatch } from './dispatch.ts'
import type { Simulation } from './simulation.ts'
import type { WeavePlan } from './weave-plan.ts'
import type { SceneSheet } from './scene-sheet.ts'

/**
 * 章节流水线步骤（文档 §3.8）。
 * 七个步骤固定顺序，见 STEP_ORDER；步骤状态机驱动断点续跑。
 */
export type Step = 'direct' | 'simulate' | 'merge' | 'write' | 'audit' | 'censor' | 'settle'

/** 步骤固定顺序：direct → simulate → merge → write → audit → censor → settle。 */
export const STEP_ORDER = [
  'direct',
  'simulate',
  'merge',
  'write',
  'audit',
  'censor',
  'settle',
] as const satisfies readonly Step[]

/**
 * 章节状态（文档 §3.8）。
 * 与 step 对应：每完成一步推进一个状态；approved 由终审或人工放行写入。
 */
export type ChapterStatus =
  | 'planned'
  | 'simulated'
  | 'woven'
  | 'drafted'
  | 'audited'
  | 'censored'
  | 'settled'
  | 'approved'

/**
 * 章节状态机实例（文档 §3.8，产物字段按章节级运行时结构收敛）。
 * 产物字段与 story/runtime/ 落盘文件一一对应（小说级文档 §11 目录）：
 * dispatch.json / sims.json / weaveplan.json / scenesheet.json / 正文 / audit.json / censor.json。
 * ⑦settle 的 RuntimeDelta 分解为 hooks.json + facts.json + 状态更新，不留存在本章状态中。
 */
export interface ChapterState {
  readonly bookId: BookId
  readonly chapter: number
  /** 当前步骤：断点续跑从该 step 继续，不重跑前序。 */
  readonly step: Step
  readonly status: ChapterStatus
  /** 重试计数：audit/censor 不过回 write 重写，maxHookRetries 封顶。 */
  readonly retries: number
  /** ①direct 拍摄单（章节级文档 §5.2）。 */
  readonly dispatch?: Dispatch
  /** ②simulate 角色模拟结果（章节级文档 §6）。 */
  readonly sims?: readonly Simulation[]
  /** ③merge 排程方案：Timeline Manager 产出（章节级文档 §7.2，落 weaveplan.json）。 */
  readonly weavePlan?: WeavePlan
  /** ③merge 线性拍摄单：Merger 产出（章节级文档 §7.4，落 scenesheet.json）。 */
  readonly scenesheet?: SceneSheet
  /** ④write 正文（落 chapters/）。 */
  readonly draft?: string
  /** ⑤audit 报告（落 audit.json）。 */
  readonly auditReport?: string
  /** ⑥censor 报告（落 censor.json）。 */
  readonly censorReport?: string
}
