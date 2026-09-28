import type { Dispatch, EventId, WeavePlan } from '../../novel/types'
import type { AgentPort } from '../agent-port.ts'
import { artifactOf, type StepNode } from '../types.ts'
import { parseSceneSheet, runAgentTask } from './parse.ts'

/** 排程占位：真实实现为 TimelineManager.checkWeaveEligibility（确定性服务，文档 §7.2）。 */
export function minimalWeavePlan(dispatch: Dispatch): WeavePlan {
  return {
    mainEvents: dispatch.threadPlan.flatMap((t) => t.eventIds).map((id) => id as EventId),
    sideInserts: [],
    blocked: [],
  }
}

/** 指令：要求输出严格符合 SceneSheet 结构的线性拍摄单（带结构示例 few-shot）。Merger 只编排不创作：
 * 素材只来自 Dispatch / Simulation[]，不得新增剧情、新伏笔或角色决策；hookOps 无 defer（挂起只在 Director 层）。 */
export const MERGE_INSTRUCTION = `你是线性拍摄单合成器。基于 Dispatch、角色模拟与排程方案，输出 SceneSheet（严格 JSON，禁止 Markdown 代码块，禁止额外包装键）。

规则：素材（台词/动作/怀疑）只来自角色模拟，不得新增剧情、新伏笔或角色决策；场景内的伏笔操作（hookOps）只允许 open|advance|resolve|mention（无 defer），hookId 必须来自 Dispatch.hookDirectives 或账本；cast/pov 必须来自 Dispatch.castPlan；转场与节奏提示写进 weavingNotes；forbidden 继承 Dispatch 的 hardLimits。

严格按以下结构输出（字段名与类型必须一致，数组不能缺）：
{
  "writingPlan": "2-3 句：本章怎么拍",
  "scenes": [
    {
      "no": 1,
      "kind": "main|side|transition",
      "pov": "视角角色（来自 castPlan）",
      "slot": "start|middle|end",
      "purpose": "场景目的",
      "beats": ["要落的内容"],
      "cast": ["出场角色"],
      "material": { "lines": ["台词素材"], "actions": ["动作素材"], "suspects": ["角色怀疑（无则空数组）"] },
      "hookOps": [ { "hookId": "H00x", "op": "advance", "how": "怎么推进", "echo": "回收呼应摘录（可选）" } ],
      "budgetChars": 800,
      "emotion": "情绪基调"
    }
  ],
  "weavingNotes": "转场技巧与节奏提醒",
  "forbidden": ["继承 Dispatch.hardLimits 的禁项"]
}
示例（最小合法结构，字段不可省略）：
{"writingPlan":"示例排程说明","scenes":[],"weavingNotes":"","forbidden":[]}`

/** merge 节点（参考实现）：weavePlan 用确定性占位（TimelineManager 位置），scenesheet 经 AgentPort 生成。 */
export function createMergeNode(agent: AgentPort): StepNode<'merge'> {
  return {
    step: 'merge',
    run: async (ctx) => {
      const dispatch = artifactOf(ctx, 'direct')
      const sims = artifactOf(ctx, 'simulate')
      if (dispatch === undefined || sims === undefined) {
        return { outcome: { kind: 'fail', reason: 'merge 缺少 direct/simulate 产物' } }
      }
      const call = await runAgentTask(agent, {
        task: 'merge',
        instruction: MERGE_INSTRUCTION,
        context: JSON.stringify({ dispatch, sims }),
        outputFormat: 'json',
      })
      if (!call.ok) return { outcome: { kind: 'fail', reason: `merge agent 调用失败：${call.reason}` } }
      const scenesheet = parseSceneSheet(call.output)
      if (scenesheet === undefined) {
        return { outcome: { kind: 'retry', step: 'merge', reason: 'merge 产物不是合法 SceneSheet JSON' } }
      }
      return { outcome: { kind: 'continue' }, output: { weavePlan: minimalWeavePlan(dispatch), scenesheet } }
    },
  }
}
