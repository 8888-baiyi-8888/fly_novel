import type { AgentPort } from '../agent-port.ts'
import { artifactOf, type StepNode } from '../types.ts'
import { runAgentTask } from './parse.ts'

/** 指令：基于正文 + Dispatch/拍摄单逐项比对（漏收伏笔/角色限制/事实矛盾）；PASS/FAIL 前缀判定。 */
export const AUDIT_INSTRUCTION = `你是内容审计员。基于正文与 Dispatch/拍摄单逐项比对：
1. 漏收伏笔：Dispatch.hookDirectives 的 resolve/advance/mention 是否在正文中落地（对应场景的 hookOps 是否兑现）；
2. 违背角色限制：正文是否违反 Dispatch.hardLimits 与 castPlan 的角色限制；
3. 事实矛盾：正文是否与角色模拟/真相快照冲突。
全部通过输出以 PASS 开头；发现问题输出以 FAIL 开头并列出条目（编号 + 问题 + 涉及伏笔/角色）。`

/**
 * audit 节点（参考实现）：报告以 FAIL 开头 → 回 write 重写（引擎重试预算内）。
 * context 含正文 + Dispatch + SceneSheet（比对材料）；判定规则为参考策略（§7.7 六步校验语义），真实策略由 B 细化。
 */
export function createAuditNode(agent: AgentPort): StepNode<'audit'> {
  return {
    step: 'audit',
    run: async (ctx) => {
      const draft = artifactOf(ctx, 'write')
      const dispatch = artifactOf(ctx, 'direct')
      const merge = artifactOf(ctx, 'merge')
      if (draft === undefined || dispatch === undefined || merge === undefined) {
        return { outcome: { kind: 'fail', reason: 'audit 缺少 write/direct/merge 产物' } }
      }
      const call = await runAgentTask(agent, {
        task: 'audit',
        instruction: AUDIT_INSTRUCTION,
        context: JSON.stringify({ draft, dispatch, scenesheet: merge.scenesheet }),
      })
      if (!call.ok) return { outcome: { kind: 'fail', reason: `audit agent 调用失败：${call.reason}` } }
      const report = call.output.text.trim()
      if (report === '') return { outcome: { kind: 'retry', step: 'audit', reason: 'audit 产物为空' } }
      if (report.startsWith('FAIL')) {
        return { outcome: { kind: 'retry', step: 'write', reason: `审计未通过：${report.slice(0, 120)}` } }
      }
      return { outcome: { kind: 'continue' }, output: report }
    },
  }
}
