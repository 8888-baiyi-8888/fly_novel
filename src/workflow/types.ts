import type { BookId, ChapterState, Dispatch, RuntimeDelta, SceneSheet, Simulation, Step, WeavePlan } from '../novel/types'

/**
 * ③merge 节点的完整产物：排程方案（Timeline Manager 产出，§7.2）+ 线性拍摄单（Merger 产出，§7.4）。
 * 两者独立落盘（小说级文档 §11 目录：weaveplan.json / scenesheet.json）。
 */
export interface MergeArtifacts {
  readonly weavePlan: WeavePlan
  readonly scenesheet: SceneSheet
}

/**
 * 章节流 7 步各自的产物类型（章节级文档 7 步流水线）：
 * direct→Dispatch、simulate→Simulation[]、merge→{weavePlan, scenesheet}、write→正文、
 * audit/censor→报告、settle→RuntimeDelta。
 */
export interface ChapterStepArtifacts {
  readonly direct: Dispatch
  readonly simulate: readonly Simulation[]
  readonly merge: MergeArtifacts
  readonly write: string
  readonly audit: string
  readonly censor: string
  readonly settle: RuntimeDelta
}

/** 步骤产物类型工具：NodeOutputOf<'direct'> = Dispatch。 */
export type NodeOutputOf<S extends Step> = ChapterStepArtifacts[S]

/** 步骤输出：节点产物只能是章节运行时结构之一（或纯文本报告）。 */
export type NodeOutput = Dispatch | readonly Simulation[] | MergeArtifacts | WeavePlan | SceneSheet | string | RuntimeDelta

/**
 * 步骤执行结果状态：
 * continue=正常完成推进下一步；retry=回退到指定步骤重试；
 * suspend=挂起等待人类；fail=直接失败终止。
 */
export type StepOutcome =
  | { readonly kind: 'continue' }
  | { readonly kind: 'retry'; readonly step: Step; readonly reason: string }
  | { readonly kind: 'suspend'; readonly reason: string }
  | { readonly kind: 'fail'; readonly reason: string }

/** 步骤节点执行结果：outcome 决定引擎行为，output 自动按步骤名写入工件表。 */
export interface StepResult<O = NodeOutput> {
  readonly outcome: StepOutcome
  readonly output?: O
}

/** 步骤节点执行上下文（只读）：state 为执行该步骤时的最新章节状态。 */
export interface StepRunContext {
  readonly bookId: BookId
  readonly chapter: number
  readonly state: ChapterState
  /** 前序步骤产物，按步骤名索引；重试时被回退到的步骤之后的产物会随重跑被覆盖。 */
  readonly artifacts: Readonly<Record<string, NodeOutput>>
}

/**
 * 步骤节点契约：给定上下文，产出结果与可选产物。
 * 泛型 S 约束步骤名，O 默认收敛为该步骤的产物类型——例如 `StepNode<'direct'>` 的 output 即 Dispatch。
 */
export interface StepNode<S extends Step = Step, O = NodeOutputOf<S>> {
  readonly step: S
  readonly run: (ctx: StepRunContext) => Promise<StepResult<O>>
}

/** 从执行上下文按步骤名安全取前序产物：该步骤尚未产出时返回 undefined。 */
export function artifactOf<S extends Step>(ctx: StepRunContext, step: S): NodeOutputOf<S> | undefined {
  return ctx.artifacts[step] as NodeOutputOf<S> | undefined
}

/** 断点持久化记录：状态 + 工件，由存储实现决定序列化方式。 */
export interface PersistedWorkflow {
  readonly bookId: BookId
  readonly chapter: number
  readonly state: ChapterState
  readonly artifacts: Record<string, NodeOutput>
}

/** 存储抽象：引擎的落盘与续跑唯一入口。 */
export interface WorkflowStore {
  load(bookId: BookId, chapter: number): Promise<PersistedWorkflow | undefined>
  save(record: PersistedWorkflow): Promise<void>
}

/** 引擎运行事件，供挂起通知 / 日志 / 监控使用。 */
export type WorkflowEvent =
  | { readonly type: 'step-completed'; readonly bookId: BookId; readonly chapter: number; readonly step: Step; readonly state: ChapterState }
  | { readonly type: 'retrying'; readonly bookId: BookId; readonly chapter: number; readonly from: Step; readonly to: Step; readonly attempt: number }
  | { readonly type: 'suspended'; readonly bookId: BookId; readonly chapter: number; readonly step: Step; readonly reason: string; readonly state: ChapterState }
  | { readonly type: 'failed'; readonly bookId: BookId; readonly chapter: number; readonly step: Step; readonly reason: string; readonly state: ChapterState }
  | { readonly type: 'completed'; readonly bookId: BookId; readonly chapter: number; readonly state: ChapterState }

/** 引擎一次运行的结果。 */
export type ChapterWorkflowResult =
  | { readonly kind: 'completed'; readonly state: ChapterState }
  | { readonly kind: 'already-complete'; readonly state: ChapterState }
  | { readonly kind: 'suspended'; readonly state: ChapterState; readonly reason: string }
  | { readonly kind: 'failed'; readonly state: ChapterState; readonly reason: string }
  | { readonly kind: 'invalid'; readonly reason: string }
