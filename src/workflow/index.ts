/**
 * 工作流编排（章节级 LangGraph 与小说级状态图）。
 * 节点契约与旧执行器见 types.ts / engine.ts；章节图见 chapter_workflow/；agent 端口与模拟实现见 agent-port.ts / stub-agent.ts；
 * 章节业务节点见 chapter_workflow/nodes/；测试见 tests/。
 */
export * from './types.ts'
export { ChapterWorkflow, createInitialChapterState, statusAfterStep } from './engine.ts'
export type { ChapterWorkflowOptions } from './engine.ts'
export { buildChapterGraph, runChapterGraph, ChapterGraphStateSchema } from './chapter_workflow/index.ts'
export type { ChapterGraphOptions, RunChapterGraphOptions } from './chapter_workflow/index.ts'
export * from './agent-port.ts'
export { StubAgent } from './stub-agent.ts'
export type { StubResponse, StubRule } from './stub-agent.ts'
export { createHttpAgent } from './http-agent.ts'
export type { HttpAgentOptions } from './http-agent.ts'
export { createOpenAICompatibleAgent } from './openai-compatible-agent.ts'
export type { OpenAICompatibleAgentOptions } from './openai-compatible-agent.ts'
export { createJsonFileStore } from './file-store.ts'
export type { JsonFileStoreOptions } from './file-store.ts'
export { buildChapterNodes, createDirectNode, createSimulateNode, createMergeNode, createWriteNode, createAuditNode, createCensorNode, createSettleNode, minimalWeavePlan } from './chapter_workflow/nodes/index.ts'
export type { ChapterNodesDeps, DirectNodeDeps } from './chapter_workflow/nodes/index.ts'
