import type { AgentPort } from '../../agent-port.ts'
import { artifactOf, type StepNode } from '../../types.ts'
import { runAgentTask } from './parse.ts'
import type { ChapterState } from '../../../novel/types'
import type { ChapterGraphState } from '../state'

/** 指令占位：真实实现为 Censor 组件（文档 §16.1），L0 确定性扫描 + LLM 语义审查。 */
export const CENSOR_INSTRUCTION = `你是内容审查员。按平台红线审查正文。通过输出以 PASS 开头；发现问题输出以 FAIL 开头并列出条目与修改建议。`

/** censor 节点（参考实现）：报告以 FAIL 开头 → 回 write 重写（引擎重试预算内）。 */
export function createCensorNode(agent: AgentPort): StepNode<'censor'> {
  return {
    step: 'censor',
    run: async (ctx) => {
      const draft = artifactOf(ctx, 'write')
      if (draft === undefined) return { outcome: { kind: 'fail', reason: 'censor 缺少 write 产物' } }
      const call = await runAgentTask(agent, {
        task: 'censor',
        instruction: CENSOR_INSTRUCTION,
        context: draft,
      })
      if (!call.ok) return { outcome: { kind: 'fail', reason: `censor agent 调用失败：${call.reason}` } }
      const report = call.output.text.trim()
      if (report === '') return { outcome: { kind: 'retry', step: 'censor', reason: 'censor 产物为空' } }
      if (report.startsWith('FAIL')) {
        return { outcome: { kind: 'retry', step: 'write', reason: `审查未通过：${report.slice(0, 120)}` } }
      }
      return { outcome: { kind: 'continue' }, output: report }
    },
  }
}

/** LangGraph censor 节点入口：调用本文件的业务节点并写回审查报告/outcome。 */
export function createCensorGraphNode(agent: AgentPort) {
  const node = createCensorNode(agent)
  return async (state: ChapterGraphState) => {
    const result = await node.run({ bookId: state.bookId, chapter: state.chapter, state: state as ChapterState, artifacts: state.artifacts })
    return {
      artifacts: result.outcome.kind === 'continue' && result.output !== undefined
        ? { ...state.artifacts, censor: result.output }
        : state.artifacts,
      outcome: result.outcome,
    }
  }
}
