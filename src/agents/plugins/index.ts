import type { AgentPluginDefinition } from '../core/contracts/agent.js'
import { characterPluginDefinitions } from '../character/plugins.js'
import { characterCreatorSystemPromptPluginDefinition } from '@fly-novel/character-creator-system-prompt'
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
import { toolSkillPluginDefinition } from '@fly-novel/tool-skill'
import { subagentPluginDefinition } from '@fly-novel/subagent'
import { spawnInProcessPluginDefinition } from '@fly-novel/subagent-spawn-in-process'
import { forkInProcessPluginDefinition } from '@fly-novel/subagent-fork-in-process'
import { genericSubagentSystemPromptDefinition } from '../generic-subagent/system-prompt.js'
import { toolSubagentPluginDefinition } from '@fly-novel/tool-subagent'

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
  toolSkillPluginDefinition,
  subagentPluginDefinition,
  spawnInProcessPluginDefinition,
  forkInProcessPluginDefinition,
  genericSubagentSystemPromptDefinition,
  toolSubagentPluginDefinition,
  ...characterPluginDefinitions,
  characterCreatorSystemPromptPluginDefinition,
  directorSystemPromptPluginDefinition,
  writerSystemPromptPluginDefinition,
  worldInitializationSystemPromptPluginDefinition,
]
