import type { AgentPluginDefinition } from '../core/contracts/agent.js'
import { characterPluginDefinitions } from '../character/plugins.js'
import { directorSystemPromptPluginDefinition } from '@fly-novel/director-system-prompt'
import { writerSystemPromptPluginDefinition } from '../writer/system-prompt-plugin.js'
import { worldInitializationSystemPromptPluginDefinition } from '@fly-novel/world-initialization-system-prompt'
import { agentLoopRuntimePluginDefinition } from '@fly-novel/agent-loop'
import { mockMemoryPluginDefinition } from './memory/index.js'
import { llmPluginDefinition } from './llm/index.js'
import { sessionPluginDefinition } from '@fly-novel/session'
import { systemPromptPluginDefinition } from '@fly-novel/system-prompt'
import { toolsPluginDefinition } from '@fly-novel/tools'
import { skillPluginDefinition } from '@fly-novel/skill'
import { filesystemSkillPluginDefinition } from '@fly-novel/skill-filesystem'
import { skillToolPluginDefinition } from '@fly-novel/tool-skill'

/** 启动时可用的内置插件定义；具体 Agent 由各自 Preset 选择。 */
export const builtInPlugins: AgentPluginDefinition[] = [
  agentLoopRuntimePluginDefinition,
  mockMemoryPluginDefinition,
  llmPluginDefinition,
  sessionPluginDefinition,
  systemPromptPluginDefinition,
  toolsPluginDefinition,
  skillPluginDefinition,
  filesystemSkillPluginDefinition,
  skillToolPluginDefinition,
  ...characterPluginDefinitions,
  directorSystemPromptPluginDefinition,
  writerSystemPromptPluginDefinition,
  worldInitializationSystemPromptPluginDefinition,
]
