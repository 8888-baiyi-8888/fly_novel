import { STEP_ORDER } from '../novel/types'
import type { BookId, ChapterState, ChapterStatus, Step } from '../novel/types'
import type { ChapterWorkflowResult, NodeOutput, PersistedWorkflow, StepNode, WorkflowEvent, WorkflowStore } from './types.ts'

export interface ChapterWorkflowOptions {
  /** 七步节点，注册顺序无关，按 STEP_ORDER 顺序执行。 */
  readonly nodes: readonly StepNode[]
  readonly store: WorkflowStore
  /** 每章重写预算：audit/censor 不过回 write 的重试次数上限（BookConfig.maxHookRetries 默认 2）。 */
  readonly maxRetries: number
  /** 事件回调（挂起/失败/完成/重试），可选。 */
  readonly notify?: (event: WorkflowEvent) => void
}

/** 步骤完成后的阶段状态：每完成一步，status 推进到该步骤对应的阶段。direct 为规划步骤，完成后仍为 planned。 */
export function statusAfterStep(step: Step): ChapterStatus {
  switch (step) {
    case 'direct': return 'planned'
    case 'simulate': return 'simulated'
    case 'merge': return 'woven'
    case 'write': return 'drafted'
    case 'audit': return 'audited'
    case 'censor': return 'censored'
    case 'settle': return 'settled'
  }
}

/** 构造初始章节状态：从 direct 开始，status=planned，retries=0。 */
export function createInitialChapterState(bookId: BookId, chapter: number): ChapterState {
  return { bookId, chapter, step: 'direct', status: 'planned', retries: 0 }
}

/** 推进状态：step → 下一步骤（settle 为末步，完成后停留），status → 该步骤对应阶段。 */
function advanceChapterState(state: ChapterState, completed: Step): ChapterState {
  const nextIndex = STEP_ORDER.indexOf(completed) + 1
  const step: Step = nextIndex < STEP_ORDER.length ? STEP_ORDER[nextIndex] : completed
  return { ...state, step, status: statusAfterStep(completed) }
}

/**
 * 章节流水线执行器：按 STEP_ORDER 顺序执行七个步骤节点。
 * 支持重试回退（retry 到目标步骤，预算封顶后挂起）、断点续跑（从 ChapterState.step 继续）、
 * 挂起/失败通知。每次状态变化后经 WorkflowStore 落盘。
 */
export class ChapterWorkflow {
  private readonly nodes: ReadonlyMap<Step, StepNode>
  private readonly store: WorkflowStore
  private readonly maxRetries: number
  private readonly notify?: (event: WorkflowEvent) => void

  constructor(options: ChapterWorkflowOptions) {
    const nodes = new Map<Step, StepNode>()
    for (const node of options.nodes) {
      if (!STEP_ORDER.includes(node.step)) throw new Error(`非法步骤节点: ${node.step}`)
      if (nodes.has(node.step)) throw new Error(`重复步骤节点: ${node.step}`)
      nodes.set(node.step, node)
    }
    this.nodes = nodes
    this.store = options.store
    this.maxRetries = options.maxRetries
    this.notify = options.notify
  }

  /**
   * 执行一章：无持久化记录时从 direct 开始；有记录时从 state.step 续跑。
   * @returns completed（settle 完成）/ already-complete / suspended / failed / invalid。
   */
  async run(bookId: BookId, chapter: number): Promise<ChapterWorkflowResult> {
    const persisted = await this.store.load(bookId, chapter)
    let state: ChapterState
    const artifacts: Record<string, NodeOutput> = {}
    if (persisted === undefined) {
      state = createInitialChapterState(bookId, chapter)
    } else {
      state = persisted.state
      if (state.status === 'settled' || state.status === 'approved') {
        return { kind: 'already-complete', state }
      }
      Object.assign(artifacts, persisted.artifacts)
    }

    for (let i = STEP_ORDER.indexOf(state.step); i < STEP_ORDER.length; i++) {
      const step = STEP_ORDER[i]
      const node = this.nodes.get(step)
      if (node === undefined) {
        return { kind: 'invalid', reason: `缺少节点: ${step}` }
      }
      const result = await node.run({ bookId, chapter, state, artifacts })

      if (result.outcome.kind === 'continue') {
        if (result.output !== undefined) artifacts[step] = result.output
        state = advanceChapterState(state, step)
        await this.store.save({ bookId, chapter, state, artifacts })
        this.notify?.({ type: 'step-completed', bookId, chapter, step, state })
        continue
      }

      if (result.outcome.kind === 'retry') {
        if (!STEP_ORDER.includes(result.outcome.step)) {
          return { kind: 'invalid', reason: `非法回退目标: ${result.outcome.step}` }
        }
        if (state.retries < this.maxRetries) {
          state = { ...state, step: result.outcome.step, retries: state.retries + 1 }
          await this.store.save({ bookId, chapter, state, artifacts })
          this.notify?.({ type: 'retrying', bookId, chapter, from: step, to: result.outcome.step, attempt: state.retries })
          i = STEP_ORDER.indexOf(result.outcome.step) - 1
          continue
        }
        // 预算耗尽：挂起等待人类，现场保留（step 停在回退目标，便于续跑时从该步重试）
        state = { ...state, step: result.outcome.step }
        await this.store.save({ bookId, chapter, state, artifacts })
        this.notify?.({ type: 'suspended', bookId, chapter, step, reason: result.outcome.reason, state })
        return { kind: 'suspended', state, reason: result.outcome.reason }
      }

      if (result.outcome.kind === 'suspend') {
        await this.store.save({ bookId, chapter, state, artifacts })
        this.notify?.({ type: 'suspended', bookId, chapter, step, reason: result.outcome.reason, state })
        return { kind: 'suspended', state, reason: result.outcome.reason }
      }

      // fail
      await this.store.save({ bookId, chapter, state, artifacts })
      this.notify?.({ type: 'failed', bookId, chapter, step, reason: result.outcome.reason, state })
      return { kind: 'failed', state, reason: result.outcome.reason }
    }

    this.notify?.({ type: 'completed', bookId, chapter, state })
    return { kind: 'completed', state }
  }
}
