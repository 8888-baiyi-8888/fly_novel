import type { ToolCallId } from '@fly-novel/llm'
import type { AssistantMessage, SystemMessage, ToolResultMessage, UserMessage } from '@fly-novel/llm'

/** 一轮运行正常完成。 */
export interface TurnEndReasonMap {
  completed: { readonly kind: 'completed' }
  aborted: { readonly kind: 'aborted'; readonly reason: 'user' | 'parent' | 'disposed' }
  blocked: { readonly kind: 'blocked' }
  error: { readonly kind: 'error'; readonly message: string }
  'max-tokens': { readonly kind: 'max-tokens' }
  'max-steps': { readonly kind: 'max-steps'; readonly maxSteps: number }
}

/** 由事件生产方说明本轮为何结束；可通过声明合并扩展。 */
export type TurnEndReason = TurnEndReasonMap[keyof TurnEndReasonMap]

/**
 * 会话事件类型表。Agent Loop 与插件通过声明合并扩展事件，事件负载由 type 键确定。
 */
export interface SessionEventMap {
  'turn/start': { readonly turn: number }
  'turn/end': { readonly turn: number; readonly reason: TurnEndReason }
  'step/start': { readonly turn: number; readonly step: number }
  'step/end': { readonly turn: number; readonly step: number }
  'system/message': { readonly turn: number; readonly step: number; readonly message: SystemMessage }
  'user/message': UserMessage
  'assistant/message': { readonly turn: number; readonly step: number; readonly message: AssistantMessage }
  'tool/call': {
    readonly turn: number
    readonly step: number
    readonly callId: ToolCallId
    readonly name: string
    /** 模型生成的原始 JSON 参数文本。 */
    readonly arguments: string
  }
  'tool/result': {
    readonly turn: number
    readonly step: number
    readonly message: ToolResultMessage
    /** 执行失败的结构化信息，不进入模型消息。 */
    readonly error?: { readonly name: string; readonly code: string }
  }
}

/** 事件类型表中的可追加类型。 */
export type SessionEventType = keyof SessionEventMap

/** 一条带有 Session 顺序号和记录时间的不可变事件。 */
export type SessionEvent<T extends SessionEventType = SessionEventType> = {
  [K in T]: {
    readonly type: K
    /** Session 内从零开始且连续递增的顺序号。 */
    readonly seq: number
    /** 事件写入时的 Unix 毫秒时间戳。 */
    readonly time: number
    readonly data: SessionEventMap[K]
  }
}[T]

/** 会产生或携带模型消息的 Session 事件类型。 */
export type SessionMessageEventType =
  | 'system/message'
  | 'user/message'
  | 'assistant/message'
  | 'tool/result'

/** 从 Session 日志派生模型消息时可消费的事件联合。 */
export type SessionMessageEvent = SessionEvent<SessionMessageEventType>
