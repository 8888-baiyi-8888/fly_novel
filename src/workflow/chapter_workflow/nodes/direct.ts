import type { DispatchGateLedgerEntry } from '../../../novel/gates/dispatch-gate'
import { validateDispatch } from '../../../novel/gates/dispatch-gate'
import type { BookRuntime } from '../../../novel/runtime'
import type { ChapterState, HookId } from '../../../novel/types'
import type { ContentAgent } from '../../agent-port.ts'
import { withDispatchGate } from '../../direct-gate.ts'
import type { StepNode } from '../../types.ts'
import type { ChapterGraphState } from '../state'
import { agentOutputFromResult, describeDispatchFailure, parseDispatch } from '../parse.ts'

/** direct 节点依赖：书运行时（真实来源为小说流交付的 BookRuntime）。 */
export interface DirectNodeDeps {
  readonly runtime: BookRuntime
}

/**
 * direct 节点（参考实现）：运行时实时渲染债务表（HookLedger.viewForChapter）作为 context，
 * 经导演 Agent 生成 Dispatch JSON，形状校验后接入 §5.3 闸门；
 * 闸门拒绝 → 引擎 retry 回 direct（重试预算内重跑，耗尽挂起）。
 */
export function createDirectNode(agent: ContentAgent, deps: DirectNodeDeps): StepNode<'direct'> {
  const inner: StepNode<'direct'> = {
    step: 'direct',
    run: async (ctx) => {
      const hookContext = deps.runtime.ledger.viewForChapter(ctx.chapter)
      const characters = deps.runtime.characters.map(({ characterId, name, tier }) => ({ characterId, name, tier }))
      let result: unknown
      try {
        result = await agent.generate(`本章上下文：\n${JSON.stringify({
          chapter: ctx.chapter,
          hookContext,
          ledger: deps.runtime.ledgerView,
          threads: deps.runtime.timeline.snapshotFor(ctx.chapter),
          characters,
        }, null, 2)}`)
      } catch (error) {
        return { outcome: { kind: 'fail', reason: `direct agent 调用失败：${error instanceof Error ? error.message : String(error)}` } }
      }
      const output = agentOutputFromResult(result)
      if (output === undefined) {
        return { outcome: { kind: 'retry', step: 'direct', reason: 'direct Agent 未返回助手文本' } }
      }
      const dispatch = parseDispatch(output)
      if (dispatch === undefined) {
        return { outcome: { kind: 'retry', step: 'direct', reason: `direct 产物不是合法 Dispatch JSON（${describeDispatchFailure(output)}）` } }
      }
      const tierByName = new Map(characters.map((character) => [character.name, character.tier]))
      const unknownCharacter = dispatch.castPlan.find((cast) => !tierByName.has(cast.name))
      if (unknownCharacter !== undefined) {
        return {
          outcome: {
            kind: 'retry',
            step: 'direct',
            reason: `Dispatch 引用了角色卡中不存在的角色：${unknownCharacter.name}`,
          },
        }
      }
      const normalizedDispatch = {
        ...dispatch,
        castPlan: dispatch.castPlan.map((cast) => ({
          ...cast,
          tier: tierByName.get(cast.name)!,
        })),
      }
      return { outcome: { kind: 'continue' }, output: normalizedDispatch }
    },
  }
  return withDispatchGate(inner, (dispatch) => validateDispatch({ dispatch, context: deps.runtime.ledger.viewForChapter(ctxOf(dispatch)), ledger: deps.runtime.ledgerView as Readonly<Record<HookId, DispatchGateLedgerEntry>> }))
}

function ctxOf(dispatch: { chapter?: unknown }): number {
  return typeof dispatch.chapter === 'number' ? dispatch.chapter : 0
}

/** LangGraph direct 节点入口：调用本文件的业务节点并写回 Dispatch/outcome。 */
export function createDirectGraphNode(agent: ContentAgent, deps: DirectNodeDeps) {
  const node = createDirectNode(agent, deps)
  return async (state: ChapterGraphState) => {
    const result = await node.run({ novelId: state.novelId, chapter: state.chapter, state: state as ChapterState, artifacts: state.artifacts })
    return {
      artifacts: result.outcome.kind === 'continue' && result.output !== undefined
        ? { ...state.artifacts, direct: result.output }
        : state.artifacts,
      outcome: result.outcome,
    }
  }
}
