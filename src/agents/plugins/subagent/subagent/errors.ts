/** 启动未交付资源的回滚失败；保留启动原因和清理错误。 */
export class SubagentStartupCleanupError extends AggregateError {
  constructor(startError: unknown, cleanupError: unknown) {
    super([startError, cleanupError], 'Subagent 启动失败且清理失败')
    this.name = 'SubagentStartupCleanupError'
  }
}
