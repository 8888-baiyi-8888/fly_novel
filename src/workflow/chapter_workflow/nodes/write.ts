import type { ContentAgent } from '../../agent-port.ts'
import { artifactOf, type StepNode } from '../../types.ts'
import { agentOutputFromResult } from '../parse.ts'
import type { ChapterState } from '../../../novel/types'
import type { ChapterGraphState } from '../state'

/** 本章任务指令；稳定的正文格式、文风和禁令由 WriterAgent 系统提示词定义。 */
export const WRITE_INSTRUCTION = '根据本章排程方案与拍摄单撰写完整正文，遵守场景顺序、角色限制、已确认的情节结果和本章字数预算。'

/** write 节点（参考实现）：产出本章正文文本。 */
export function createWriteNode(agent: ContentAgent): StepNode<'write'> {
  return {
    step: 'write',
    run: async (ctx) => {
      const merge = artifactOf(ctx, 'merge')
      if (merge === undefined) return { outcome: { kind: 'fail', reason: 'write 缺少 merge 产物' } }
      let result: unknown
      try {
        result = await agent.generate(`${WRITE_INSTRUCTION}\n\n本章写作材料：\n${JSON.stringify(merge, null, 2)}`)
      } catch (error) {
        return { outcome: { kind: 'retry', step: 'write', reason: `write agent 调用失败：${error instanceof Error ? error.message : String(error)}` } }
      }
      const output = agentOutputFromResult(result)
      if (output === undefined) return { outcome: { kind: 'retry', step: 'write', reason: 'write Agent 未返回助手文本' } }
      const draft = output.text.trim()
      if (draft === '') return { outcome: { kind: 'retry', step: 'write', reason: 'write 产物为空' } }
      // 质量护栏：正文过短（<100 字）或为占位符（如 "[1]"）判定为模型未真正产出正文，重新生成
      if (draft.length < 5 || /^\[[^\]]*\]$/.test(draft)) {
        return { outcome: { kind: 'retry', step: 'write', reason: 'write 产物过短或为占位符' } }
      }
      return { outcome: { kind: 'continue' }, output: draft }
    },
  }
}

/** LangGraph write 节点入口：调用本文件的业务节点并写回正文/outcome。 */
export function createWriteGraphNode(agent: ContentAgent) {
  const node = createWriteNode(agent)
  return async (state: ChapterGraphState) => {
    const result = await node.run({ novelId: state.novelId, chapter: state.chapter, state: state as ChapterState, artifacts: state.artifacts })
    return {
      artifacts: result.outcome.kind === 'continue' && result.output !== undefined
        ? { ...state.artifacts, write: result.output }
        : state.artifacts,
      outcome: result.outcome,
    }
  }
}
