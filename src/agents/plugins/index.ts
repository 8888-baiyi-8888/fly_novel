import type { AgentPluginDefinition } from '../core/contracts/agent.js'
import { characterPluginDefinitions } from '../character/plugins.js'
import { mockLoopPluginDefinition } from './loop/index.js'
import { mockMemoryPluginDefinition } from './memory/index.js'

/** 启动时可用的内置插件定义；具体 Agent 由各自 Preset 选择。 */
export const builtInPlugins: AgentPluginDefinition[] = [
  mockLoopPluginDefinition,
  mockMemoryPluginDefinition,
  ...characterPluginDefinitions,
]
