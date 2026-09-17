/** 学习阶段复用本地 DSH 的会话与投影协议，统一维护外部依赖入口。 */
export type { ProjectionDefinition, default as SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
export type { Session, SessionEventMap, UserMessage } from '@deepseek-ai/dsh-session'
export type { AgentEventDispatch, Inbox, InboxState, InboxTarget, InboxWireState } from '@deepseek-ai/dsh-agent'
export { z } from 'zod'
// TODO: 本地 @fly-novel/llm 已定义 MessageId；迁移 Session、UserMessage 和 Inbox 时优先统一使用本地定义，当前需与 DSH Inbox 的品牌类型保持一致。
export type { MessageId } from '@deepseek-ai/dsh-llm'
