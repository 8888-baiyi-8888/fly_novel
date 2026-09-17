import type { Branded } from '@fly-novel/util'

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
