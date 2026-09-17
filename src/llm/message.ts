import type { MessageId, ToolCallId} from './brand'
import type { ContentBlock, ToolResultBlock} from './types'
import { deepFreeze } from '@fly-novel/util'
/** 助手消息的供应商、模型身份和适配器私有重放数据。 */
export interface AssistantProviderMetadata {
  /** 生成此消息的供应商路由。 */
  provider: string
  /** 生成此消息的模型标识。 */
  model: string
  /** 可无损序列化为 JSON 的响应重放状态；仅向同时拥有历史路由和目标路由的适配器实例提供。 */
  replayState?: unknown
}

/** 模型生成的助手消息来源。 */
export interface ModelMessageSource extends AssistantProviderMetadata {
  kind: 'model'
}

/** 携带工具结果的用户角色消息来源。 */
export interface ToolMessageSource {
  kind: 'tool'
  callId: ToolCallId
}

/** 上下文快照中按组装顺序排列的具名片段。 */
export interface ContextSnapshotSection {
  /** 提供片段的子系统名称。 */
  readonly name: string
  /** 组装后实际发送给模型的片段文本。 */
  readonly text: string
}

export type ContextFormed =
  | { readonly form?: never }
  | { readonly form: 'instructions' }
  | { readonly form: 'catalog' }
  | {
    readonly form: 'snapshot'
    /** 按顺序记录快照采用的具名片段。 */
    readonly sections: readonly ContextSnapshotSection[]
  }
  | {
    readonly form: 'notice'
    /** 无需展开详情即可显示的单行摘要。 */
    readonly summary: string
  }
  | { readonly form: 'relay' }
  | { readonly form: 'recall' }

export interface MessageSourceMap {
  user: { kind: 'user' }
  plugin: { kind: 'plugin'; plugin: string } & ContextFormed
  model: ModelMessageSource
  tool: ToolMessageSource
}

/** 从可扩展来源映射推导的消息来源；处理 kind 时应为外部扩展保留默认分支。 */
export type MessageSource = MessageSourceMap[keyof MessageSourceMap]

/** 消息传递、持久化历史和模型请求共用的消息表示；通过 freezeMessage 创建不可变快照。 */
export interface Message {
  /** 在不同表示之间保持稳定的消息标识。 */
  readonly id: MessageId
  /** 与供应商无关的对话角色。 */
  readonly role: 'system' | 'user' | 'assistant'
  /** 实际发送给模型的内容块。 */
  readonly content: ContentBlock[]
  /** 由消息生产方提供的来源字段。 */
  readonly source: MessageSource
}

/**共享消息表示（shared message representation）中针对用户角色（user-role）的一种特化类型。 */
export interface UserMessage extends Message {
  readonly role: 'user'
}

/**
 * 复制并深度冻结已有身份的消息。
 * @param message 包含稳定标识的完整消息。
 * @returns 保留消息身份的不可变独立快照。
 */
export function freezeMessage<T extends Message>(message: T): T {
  return deepFreeze(structuredClone(message))
}

/**
 * 共享消息表示（shared message representation）中针对系统角色（system-role）
 * 的一种特化类型：
 *
 * 表示一条已经渲染完成的系统提示词（System Prompt），
 * 并记录负责组装该提示词的插件（Plugin）。
 *
 * 当 `content` 为空时，表示“没有系统提示词”，
 * 此时不会被投影（project）为实际发送给模型的消息（wire message）。
 */
export interface SystemMessage extends Message {
  readonly role: 'system'
  readonly source: MessageSourceMap['plugin']
}

/** 共享消息表示（shared message representation）中，由模型生成的 Assistant 角色特化类型。 */
export interface AssistantMessage extends Message {
  readonly role: 'assistant'
  readonly source: ModelMessageSource
}

/**工具结果（tool-result）在共享消息表示中的一种特化类型，其中面向模型的内容块（model-facing block）会保留与对应工具调用之间的关联关系。*/
export interface ToolResultMessage extends Message {
  readonly role: 'user'
  readonly content: [ToolResultBlock]
  readonly source: ToolMessageSource
}