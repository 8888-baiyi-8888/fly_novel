import type { AgentPort } from '../agent-port.ts'
import { artifactOf, type StepNode } from '../types.ts'
import { parseSimulations, runAgentTask } from './parse.ts'

/** 指令：要求输出严格为 Simulation 数组（带结构示例 few-shot；禁止包装对象）。 */
export const SIMULATE_INSTRUCTION = `你是角色模拟器。基于 Dispatch 模拟本章出场的关键角色，输出 Simulation 数组（严格 JSON 数组，禁止 Markdown 代码块，禁止额外包装键——{"simulations": [...]} 这类包装对象一律不合格）。

规则：角色必须来自 Dispatch.castPlan；tier 用 castPlan 中的角色级别（S/A，B 级角色不模拟）；lines/actions 是素材，merge 只采信它们；suspects 是该角色此刻的怀疑（信息差）；reasoning/risk 是内心逻辑，不进正文。

严格按以下结构输出（数组的每个元素）：
{
  "character": "角色名（来自 castPlan）",
  "tier": "S|A",
  "lines": ["该角色可能的台词"],
  "actions": ["该角色可能的动作"],
  "suspects": ["此刻怀疑（无则空数组）"],
  "reasoning": "S 级：为什么这样做（可选）",
  "risk": "S 级：可能后果（可选）"
}
示例（最小合法，字段不可省略）：
[{"character":"叶凡","tier":"S","lines":["台词"],"actions":["动作"],"suspects":[]}]`

/** simulate 节点（参考实现）：一次 agent 调用产出全部角色模拟；真实实现逐角色持久会话。 */
export function createSimulateNode(agent: AgentPort): StepNode<'simulate'> {
  return {
    step: 'simulate',
    run: async (ctx) => {
      const dispatch = artifactOf(ctx, 'direct')
      if (dispatch === undefined) return { outcome: { kind: 'fail', reason: 'simulate 缺少 direct 产物' } }
      const call = await runAgentTask(agent, {
        task: 'simulate',
        instruction: SIMULATE_INSTRUCTION,
        context: JSON.stringify(dispatch),
        outputFormat: 'json',
      })
      if (!call.ok) return { outcome: { kind: 'fail', reason: `simulate agent 调用失败：${call.reason}` } }
      const sims = parseSimulations(call.output)
      if (sims === undefined) {
        const preview = JSON.stringify(call.output.text).slice(0, 200)
        return {
          outcome: {
            kind: 'retry',
            step: 'simulate',
            reason: `simulate 产物不是合法 Simulation 数组（原始输出预览：${preview}）`,
          },
        }
      }
      return { outcome: { kind: 'continue' }, output: sims }
    },
  }
}
