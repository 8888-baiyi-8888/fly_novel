import type { DispatchGateLedgerEntry } from '../../../novel/gates/dispatch-gate'
import { validateDispatch } from '../../../novel/gates/dispatch-gate'
import type { BookRuntime } from '../../../novel/runtime'
import type { ChapterState, HookId } from '../../../novel/types'
import type { ContentAgent } from '../../agent-port.ts'
import { z } from 'zod'
import { withDispatchGate } from '../../direct-gate.ts'
import type { StepNode } from '../../types.ts'
import type { ChapterGraphState } from '../state'
import { agentOutputFromResult, describeDispatchFailure, parseDispatch } from '../parse.ts'

/** direct 节点依赖：书运行时（真实来源为小说流交付的 BookRuntime）。 */
export interface DirectNodeDeps {
  readonly runtime: BookRuntime
}

const dispatchSchema = z.object({
  chapter: z.number(),
  goal: z.string(),
  castPlan: z.array(z.object({
    name: z.string(),
    tier: z.enum(['S', 'A', 'B']),
    role: z.enum(['main', 'support', 'cameo']),
    directive: z.string(),
    agentQuery: z.string().optional(),
    hardLimits: z.array(z.string()),
  })),
  threadPlan: z.array(z.object({
    threadId: z.string(),
    eventIds: z.array(z.string()),
    slot: z.enum(['start', 'middle', 'end']),
  })),
  hookDirectives: z.object({
    open: z.array(z.object({
      type: z.enum(['物件', '身份', '信息差', '承诺', '威胁', '秘密', '关系', '能力', '事件']),
      description: z.string(),
      payoffTiming: z.enum(['immediate', 'near-term', 'mid-arc', 'slow-burn', 'endgame']),
      expectedPayoff: z.string(),
      echoHint: z.string(),
    })),
    advance: z.array(z.object({ hookId: z.string(), how: z.string(), to: z.literal('progressing') })),
    resolve: z.array(z.object({ hookId: z.string(), how: z.string(), echoFrom: z.string() })),
    defer: z.array(z.object({ hookId: z.string(), reason: z.string(), untilChapter: z.number() })),
    mention: z.array(z.string()),
  }),
  styleNotes: z.array(z.string()),
  budget: z.object({ scenes: z.number(), chars: z.number() }),
})

const DIRECT_INSTRUCTION = `你是章节导演。基于债务表、线程快照与账本，输出本章 Dispatch 拍摄单。

必须满足：覆盖 mustResolve/mustAdvance 全部项；hookId 必须来自账本（不得编造）；不得 resolve 尚未埋设的伏笔；open 数不得多于 resolve 数；budget.openAllowed=false 时不得 open；coreHook 不得 defer；threadId/eventId 必须来自提供的线程快照；castPlan 中的角色名和级别必须来自 characters 列表。

严格按 Dispatch 结构输出。字段不能缺失。`

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
        result = await agent.generate(`${DIRECT_INSTRUCTION}\n\n本章上下文：\n${JSON.stringify({
          chapter: ctx.chapter,
          hookContext,
          ledger: deps.runtime.ledgerView,
          threads: deps.runtime.timeline.snapshotFor(ctx.chapter),
          characters,
        }, null, 2)}`, { responseFormat: dispatchSchema })
      } catch (error) {
        return { outcome: { kind: 'fail', reason: `direct agent 调用失败：${error instanceof Error ? error.message : String(error)}` } }
      }
      if (typeof result === 'object' && result !== null && 'structuredResponseError' in result) {
        const reason = result.structuredResponseError
        return {
          outcome: {
            kind: 'retry',
            step: 'direct',
            reason: `Dispatch 不符合输出结构：${typeof reason === 'string' ? reason : String(reason)}`,
          },
        }
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
