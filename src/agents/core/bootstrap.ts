import type { Context } from '@deepseek-ai/cordis'
import { PluginRegistry, PresetRegistry } from './preset.js'
import { AgentFactory } from '../runtime/agent-factory.js'
import { AgentManager } from '../runtime/agent-manager.js'
import { mockLoopPlugin } from '../plugins/loop/index.js'
import { mockMemoryPlugin } from '../plugins/memory/index.js'
import { characterAgentPreset } from '../character/preset.js'
import { directorAgentPreset } from '../director/preset.js'

export interface AgentFramework {
  context: Context
  plugins: PluginRegistry
  presets: PresetRegistry
  factory: AgentFactory
  manager: AgentManager
}

/** 创建 Harness 根 Context 并注册内置 mock 组件。 */
export async function bootstrapAgents(): Promise<AgentFramework> {
  const { Context } = await import('@deepseek-ai/cordis')
  const context = new Context()
  const plugins = new PluginRegistry()
  const presets = new PresetRegistry()

  plugins.register({
    id: 'mock-loop',
    version: '1.0.0',
    description: '临时 Agent loop 插件',
    plugin: mockLoopPlugin,
    defaultConfig: {},
  })

  plugins.register({
    id: 'mock-memory',
    version: '1.0.0',
    description: '临时 Agent memory 插件',
    plugin: mockMemoryPlugin,
    defaultConfig: {},
  })

  presets.register(characterAgentPreset)
  presets.register(directorAgentPreset)

  for (const preset of presets.list()) {
    for (const binding of preset.plugins) plugins.get(binding.pluginId)
  }

  const factory = new AgentFactory(context, plugins, presets)
  const manager = new AgentManager(factory)

  return { context, plugins, presets, factory, manager }
}
