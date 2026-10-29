/** 写作 Agent 包公共入口；导入包不创建 Agent 或启动模型调用。 */
export { BaseAgent } from "./core/base-agent.js";
export { CharacterAgent } from "./character/character-agent.js";
export { type CharacterAgentOptions, type CharacterInfos } from "./character/types.js";
export { CharacterAgentManager, type CharacterAgentGenerateOptions } from "./character/character-agent-manager.js";
export { DirectorAgent, type DirectorAgentOptions } from "./director/director-agent.js";
export { WriterAgent, type WriterAgentOptions } from "./writer/writer-agent.js";
export { AuditAgent, type AuditAgentOptions } from "./audit/audit-agent.js";
export { CensorAgent, type CensorAgentOptions } from "./censor/censor-agent.js";


export { AgentInstance, PluginRegistry, PresetRegistry, bootstrapAgents } from './core/index.js'
export type { Agent, AgentInfo, AgentIdentity, AgentPluginDefinition, AgentPreset, CreateAgentOptions, AgentFramework } from './core/index.js'
export { AgentFactory } from './runtime/agent-factory.js'
export { AgentManager } from './runtime/agent-manager.js'
export { characterAgentPreset } from './character/preset.js'
export { directorAgentPreset } from './director/preset.js'
export { writerAgentPreset } from './writer/preset.js'
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
export { systemPromptPluginDefinition } from './plugins/system-prompt-plugin.js'
export type { AgentMemory, MockMemoryConfig } from './plugins/memory/index.js'
