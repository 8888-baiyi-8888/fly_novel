import type { Branded } from '@fly-novel/util'
import { brandString } from '@fly-novel/util'

/** 适配器定义的模型推理强度标识。 */
export type ReasoningEffortId = Branded<'ReasoningEffortId'>

/** 在消息传递、历史记录和模型请求之间保持稳定的消息标识。 */
export type MessageId = Branded<'MessageId'>

/** 将模型工具调用与其结果关联的标识，由供应商或测试替身生成。 */
export type ToolCallId = Branded<'ToolCallId'>

/** 不可变附件的内容寻址标识。 */
export type AttachmentId = Branded<'AttachmentId'>

/** 供应商返回的请求标识，用于跨模块诊断。 */
export type ProviderRequestId = Branded<'ProviderRequestId'>


/** 
 * 一次模型流式调用尝试的唯一标识,在单个 Agent 生命周期内保持唯一。
 */
export type LlmAttemptId = Branded<'LlmAttemptId'>

/**
 * 为一个由循环（loop）管理的流式调用尝试标识符添加品牌类型。
 *
 * @param id - Agent 生命周期范围内使用的不透明标识符。
 * @returns 添加了“调用尝试 ID”品牌类型后的同一个字符串。
 */
export function LlmAttemptId(id: string): LlmAttemptId {
  return brandString<LlmAttemptId>(id)
}
