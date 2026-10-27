import type { AgentPluginDefinition } from '../core/contracts/agent.js'
import { characterPluginDefinitions } from '../character/plugins.js'
import { agentLoopRuntimePluginDefinition } from '@fly-novel/agent-loop'
import { mockLoopPluginDefinition } from './mock-loop.js'
import { mockMemoryPluginDefinition } from './memory/index.js'
import { llmPluginDefinition } from './llm/index.js'
import { sessionPluginDefinition } from '@fly-novel/session'
import { systemPromptPluginDefinition } from './system-prompt-plugin.js'

/** 启动时可用的内置插件定义；具体 Agent 由各自 Preset 选择。 */
export const builtInPlugins: AgentPluginDefinition[] = [
  mockLoopPluginDefinition,
  agentLoopRuntimePluginDefinition,
  mockMemoryPluginDefinition,
  llmPluginDefinition,
  sessionPluginDefinition,
  systemPromptPluginDefinition,
  ...characterPluginDefinitions,
]
