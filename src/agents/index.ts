/** 写作 Agent 包公共入口；导入包不创建 Agent 或启动模型调用。 */
export { BaseAgent } from "./core/base-agent.js";
export { WriterAgent, type WriterAgentOptions } from "./writer/writer-agent.js";


export { AgentInstance, PluginRegistry, PresetRegistry, bootstrapAgents } from './core/index.js'
export type { Agent, AgentInfo, AgentIdentity, AgentPluginDefinition, AgentPreset, CreateAgentOptions, AgentFramework } from './core/index.js'
export { AgentFactory } from './runtime/agent-factory.js'
export { AgentManager } from './runtime/agent-manager.js'
export { createSpawnAgentCreator, type SpawnPresetConfigs } from './runtime/subagent-in-process-creator.js'
export { characterAgentPreset } from './character/preset.js'
export { genericSubagentPreset } from './generic-subagent/preset.js'
export { directorAgentPreset } from './director/preset.js'
export { writerAgentPreset } from './writer/preset.js'
export { worldInitializationMainAgentPreset } from './world-initialization-main-agent/preset.js'
export { SessionPersistence } from '@fly-novel/session-persistence'
export type { SessionAccess, SessionHandle, SessionHeader, SessionPersistenceSnapshot } from '@fly-novel/session-persistence'
export { JsonlSessionPersistence, jsonlSessionPersistencePlugin } from './plugins/session-persistence-jsonl/index.js'
export type { JsonlSessionPersistenceConfig } from './plugins/session-persistence-jsonl/index.js'
export { mockMemoryPlugin } from './plugins/memory/index.js'
export { llmPlugin, llmPluginDefinition, type LlmPluginConfig } from './plugins/llm/index.js'
export {
  SystemPrompt,
  renderPrompt,
  systemPromptPlugin,
  type AssembleContext,
  type AssembledSection,
  type PromptAssembly,
  type PromptSection,
  type PromptTextProvider,
  type PromptVariableProvider,
  type SystemPromptPluginConfig,
} from '@fly-novel/system-prompt'
export { systemPromptPluginDefinition } from '@fly-novel/system-prompt'
export { skillPlugin, skillPluginDefinition } from '@fly-novel/skill'
export { filesystemSkillPlugin, filesystemSkillPluginDefinition } from '@fly-novel/skill-filesystem'
export type { FilesystemSkillPluginConfig } from '@fly-novel/skill-filesystem'
export type { AgentMemory, MockMemoryConfig } from './plugins/memory/index.js'
