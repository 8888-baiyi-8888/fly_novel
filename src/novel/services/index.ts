/**
 * 小说领域确定性服务（章节级文档 §16.1 组件接口）。
 * 纯函数先行：HookLedger 的 lifecycle / 准入 / 六步校验与不可变合并已实现，
 * TimelineManager / TruthOracle 先落地接口契约，行为实现留待后续。
 */
export * from './apply-delta.ts'
export * from './hook-ledger.ts'
export * from './timeline-manager.ts'
export * from './truth-oracle.ts'
