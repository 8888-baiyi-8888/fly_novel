/**
 * 由 `scripts/gen-persistence-catalog.ts` 生成——请勿手动编辑；运行
 * `pnpm run gen-persistence-catalog` 重新生成（通过
 * `pnpm run verify-persistence-catalog` 校验是否为最新内容，该检查属于 `doc-sync`）。
 * @module @deepseek-ai/dsh-session/known-event-types
 */

/**
 * 本仓库中声明的所有 `SessionEventMap` 成员，即此构建可识别的事件词汇表。
 * 持久化读取遇到集合外的事件类型时拒绝解释日志，除非事件携带信封中的 ignorable 标记（见 ./types.ts 的 SessionEvent.ignorable）。
 * 这类日志可能由较新的 Harness 写入，静默跳过必需事件会错误重建会话。
 * 仓库外的下游插件事件不在此列表中，持久化的 SessionEvent.ignorable 标记负责兼容。
 * 未采用事件名称注册机制，因为它无法判断省略是否安全，还会让读取结果依赖插件组装。
 * 设计依据见
 * `.agents/notes/implemented/architecture/2026-08-30-retain-ignorable-external-session-events.md`。
 */
export const KNOWN_SESSION_EVENT_TYPES: ReadonlySet<string> = new Set([
  'agent-preset/selected',
  'agent/inbox/spliced',
  'approval/asked',
  'approval/decided',
  'approval/policy',
  'assistant/attempt',
  'assistant/message',
  'command/done',
  'command/run',
  'compaction/end',
  'compaction/prune',
  'compaction/start',
  'compaction/summary',
  'deliverables/presented',
  'feedback/message-delete',
  'feedback/message-put',
  'feedback/record',
  'goal/change',
  'hook/invoked',
  'hook/result',
  'image/offload',
  'llm/retry',
  'llm/retry-started',
  'model/selection',
  'permission/preset',
  'plan/mode',
  'request/context',
  'request/header',
  'sandbox/mode',
  'schedule/change',
  'session-log-deepseek/delivery-accepted',
  'session/end-seed',
  'session/title',
  'session/title-llm-request',
  'step/end',
  'step/start',
  'subagent/catalog',
  'subagent/descriptor',
  'subagent/model-selection-policy',
  'system/message',
  'team/member',
  'team/message/delivered',
  'team/message/queued',
  'team/task',
  'todo/write',
  'tool-workflow/agent-end',
  'tool-workflow/agent-start',
  'tool-workflow/run-end',
  'tool-workflow/run-start',
  'tool/call',
  'tool/ptc-dispatch',
  'tool/ptc-dispatch-start',
  'tool/result',
  'turn/end',
  'turn/start',
  'user/message',
  'web/deepseek-search-llm-request',
])
/** 其模型可见效果需要显式纯函数解释器的事件类型。 */
export const MESSAGE_PROJECTION_EVENT_TYPES: ReadonlySet<string> = new Set([
  'image/offload',
])
