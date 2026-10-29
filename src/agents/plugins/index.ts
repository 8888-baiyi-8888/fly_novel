import type { AgentPluginDefinition } from '../core/contracts/agent.js'
import { characterPluginDefinitions } from '../character/plugins.js'
import { directorSystemPromptPluginDefinition } from '../director/system-prompt-plugin.js'
import { agentLoopRuntimePluginDefinition } from '@fly-novel/agent-loop'
import { mockMemoryPluginDefinition } from './memory/index.js'
import { llmPluginDefinition } from './llm/index.js'
import { sessionPluginDefinition } from '@fly-novel/session'
import { systemPromptPluginDefinition } from './system-prompt-plugin.js'
import { toolsPluginDefinition } from '@fly-novel/tools'

/** 启动时可用的内置插件定义；具体 Agent 由各自 Preset 选择。 */
export const builtInPlugins: AgentPluginDefinition[] = [
  agentLoopRuntimePluginDefinition,
  mockMemoryPluginDefinition,
  llmPluginDefinition,
  sessionPluginDefinition,
  systemPromptPluginDefinition,
  toolsPluginDefinition,
  ...characterPluginDefinitions,
  directorSystemPromptPluginDefinition,
]
