import type { AgentPluginDefinition } from '../core/contracts/agent.js'
import { characterExampleMemoryPluginDefinition } from './example-memory-plugin.js'
import { characterSystemPromptPluginDefinition } from '@fly-novel/character-system-prompt'

/** 角色 Harness Preset 可选用的插件定义。 */
export const characterPluginDefinitions: AgentPluginDefinition[] = [characterExampleMemoryPluginDefinition, characterSystemPromptPluginDefinition]
