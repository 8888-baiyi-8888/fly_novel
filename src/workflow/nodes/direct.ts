import type { DispatchGateLedgerEntry } from '../../novel/gates/dispatch-gate'
import { validateDispatch } from '../../novel/gates/dispatch-gate'
import type { BookRuntime } from '../../novel/runtime'
import { HOOK_TYPES } from '../../novel/types'
import type { HookId } from '../../novel/types'
import type { AgentPort } from '../agent-port.ts'
import { withDispatchGate } from '../direct-gate.ts'
import type { StepNode } from '../types.ts'
import { describeDispatchFailure, parseDispatch, runAgentTask } from './parse.ts'

/** direct 节点依赖：书运行时（真实来源为小说流交付的 BookRuntime）。 */
export interface DirectNodeDeps {
  readonly runtime: BookRuntime
}

/**
 * 指令：要求输出严格符合 Dispatch JSON 结构的拍摄单（带结构示例 few-shot，真实 agent 形状对齐）。
 * 明确禁止：Markdown 代码块、额外包装键（如 "dispatch"）、缺失数组字段。
 * threadId/eventId 必须来自 context.threads（线程快照），hookId 必须来自 context.ledger。
 */
export const DIRECT_INSTRUCTION = `你是章节导演。基于债务表、线程快照与账本，输出本章 Dispatch 拍摄单（严格 JSON，禁止 Markdown 代码块，禁止额外包装键如 "dispatch"）。

必须满足：覆盖 mustResolve/mustAdvance 全部项；hookId 必须来自账本（不得编造）；不得 resolve 尚未埋设的伏笔；open 数不得多于 resolve 数；budget.openAllowed=false 时不得 open；coreHook 不得 defer；threadId/eventId 必须来自提供的线程快照。

严格按以下结构输出（字段名与类型必须一致，数组不能缺）：
{
  "chapter": 1,
  "goal": "本章唯一目标（不超过 40 字）",
  "castPlan": [
    { "name": "角色名（来自角色卡）", "tier": "S|A|B", "role": "main|support|cameo", "directive": "本章要做什么", "agentQuery": "仅 S 级：向角色 Agent 的提问", "hardLimits": ["绝不能做的事"] }
  ],
  "threadPlan": [
    { "threadId": "线程ID（来自线程快照）", "eventIds": ["事件ID（来自线程快照，无则空数组）"], "slot": "start|middle|end" }
  ],
  "hookDirectives": {
    "open": [ { "type": "${HOOK_TYPES.join('|')}", "description": "描述", "payoffTiming": "immediate|near-term|mid-arc|slow-burn|endgame", "expectedPayoff": "预期回收", "echoHint": "埋设原文摘录" } ],
    "advance": [ { "hookId": "H00x", "how": "怎么推进", "to": "progressing" } ],
    "resolve": [ { "hookId": "H00x", "how": "怎么回收", "echoFrom": "账本 notes 摘录" } ],
    "defer": [ { "hookId": "H00x", "reason": "原因", "untilChapter": 99 } ],
    "mention": ["H00x"]
  },
  "styleNotes": ["风格提示"],
  "budget": { "scenes": 4, "chars": 3 }
}
示例（本章无可收/可推伏笔时的最小合法结构，字段不可省略）：
{"chapter":1,"goal":"示例目标","castPlan":[],"threadPlan":[],"hookDirectives":{"open":[],"advance":[],"resolve":[],"defer":[],"mention":[]},"styleNotes":[],"budget":{"scenes":4,"chars":3}}`

/**
 * direct 节点（参考实现）：运行时实时渲染债务表（HookLedger.viewForChapter）作为 context，
 * 经 AgentPort 生成 Dispatch JSON，形状校验后接入 §5.3 闸门；
 * 闸门拒绝 → 引擎 retry 回 direct（重试预算内重跑，耗尽挂起）。
 */
export function createDirectNode(agent: AgentPort, deps: DirectNodeDeps): StepNode<'direct'> {
  const inner: StepNode<'direct'> = {
    step: 'direct',
    run: async (ctx) => {
      const hookContext = deps.runtime.ledger.viewForChapter(ctx.chapter)
      const call = await runAgentTask(agent, {
        task: 'direct',
        instruction: DIRECT_INSTRUCTION,
        context: JSON.stringify({
          chapter: ctx.chapter,
          hookContext,
          ledger: deps.runtime.ledgerView,
          threads: deps.runtime.timeline.snapshotFor(ctx.chapter),
        }),
        outputFormat: 'json',
      })
      if (!call.ok) return { outcome: { kind: 'fail', reason: `direct agent 调用失败：${call.reason}` } }
      const dispatch = parseDispatch(call.output)
      if (dispatch === undefined) {
        return { outcome: { kind: 'retry', step: 'direct', reason: `direct 产物不是合法 Dispatch JSON（${describeDispatchFailure(call.output)}）` } }
      }
      return { outcome: { kind: 'continue' }, output: dispatch }
    },
  }
  return withDispatchGate(inner, (dispatch) => validateDispatch({ dispatch, context: deps.runtime.ledger.viewForChapter(ctxOf(dispatch)), ledger: deps.runtime.ledgerView as Readonly<Record<HookId, DispatchGateLedgerEntry>> }))
}

function ctxOf(dispatch: { chapter?: unknown }): number {
  return typeof dispatch.chapter === 'number' ? dispatch.chapter : 0
}
