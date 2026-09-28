/**
 * 工作流引擎（章节级 7 步流水线编排）。
 * 节点契约与执行器见 types.ts / engine.ts；agent 端口与模拟实现见 agent-port.ts / stub-agent.ts；
 * 参考节点见 nodes/；测试见 tests/。
 */
export * from './types.ts'
export { ChapterWorkflow, createInitialChapterState, statusAfterStep } from './engine.ts'
export type { ChapterWorkflowOptions } from './engine.ts'
export * from './agent-port.ts'
export { StubAgent } from './stub-agent.ts'
export type { StubResponse, StubRule } from './stub-agent.ts'
export { createHttpAgent } from './http-agent.ts'
export type { HttpAgentOptions } from './http-agent.ts'
export { createOpenAICompatibleAgent } from './openai-compatible-agent.ts'
export type { OpenAICompatibleAgentOptions } from './openai-compatible-agent.ts'
export { createJsonFileStore } from './file-store.ts'
export type { JsonFileStoreOptions } from './file-store.ts'
export { buildChapterNodes, createDirectNode, createSimulateNode, createMergeNode, createWriteNode, createAuditNode, createCensorNode, createSettleNode, minimalWeavePlan } from './nodes/index.ts'
export type { ChapterNodesDeps, DirectNodeDeps } from './nodes/index.ts'
