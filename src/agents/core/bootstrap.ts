import type { Context } from '@deepseek-ai/cordis'
import { PluginRegistry, PresetRegistry } from './preset.js'
import { AgentFactory } from '../runtime/agent-factory.js'
import { AgentManager } from '../runtime/agent-manager.js'
import { builtInPlugins } from '../plugins/index.js'
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

  for (const definition of builtInPlugins) plugins.register(definition)

  presets.register(characterAgentPreset)
  presets.register(directorAgentPreset)

  // 验证 Preset 中的插件绑定是否存在于 PluginRegistry 中
  for (const preset of presets.list()) {
    for (const binding of preset.plugins) plugins.get(binding.pluginId)
  }

  const factory = new AgentFactory(context, plugins, presets)
  const manager = new AgentManager(factory)

  return { context, plugins, presets, factory, manager }
}
