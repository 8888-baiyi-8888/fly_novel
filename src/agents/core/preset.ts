import type {
  AgentPluginDefinition,
} from './contracts/agent.js'
import type { AgentPreset } from './contracts/preset.js'

export class PluginRegistry {
  private readonly items = new Map<string, AgentPluginDefinition>()

  register<TConfig>(definition: AgentPluginDefinition<TConfig>): void {
    const id = definition.id.trim()

    if (!id) throw new Error('插件 ID 不能为空')
    if (!definition.version.trim()) {
      throw new Error(`插件 "${id}" 必须填写版本`)
    }
    if (this.items.has(id)) {
      throw new Error(`插件 "${id}" 已注册`)
    }

    this.items.set(id, { ...definition, id } as AgentPluginDefinition)
  }

  get(id: string): AgentPluginDefinition {
    const definition = this.items.get(id)
    if (!definition) throw new Error(`插件 "${id}" 尚未注册`)
    return definition
  }

  list(): AgentPluginDefinition[] {
    return [...this.items.values()]
  }

}

export class PresetRegistry {
  private readonly items = new Map<string, AgentPreset>()

  register(preset: AgentPreset): void {
    const id = preset.id.trim()

    if (!id) throw new Error('Preset ID 不能为空')
    if (!preset.version.trim()) {
      throw new Error(`Preset "${id}" 必须填写版本`)
    }
    if (this.items.has(id)) {
      throw new Error(`Preset "${id}" 已注册`)
    }

    this.items.set(id, {
      ...preset,
      id,
      defaultParameters: preset.defaultParameters && { ...preset.defaultParameters },
      plugins: preset.plugins.map((binding) => ({ ...binding })),
    })
  }

  get(id: string): AgentPreset {
    const preset = this.items.get(id)
    if (!preset) throw new Error(`Preset "${id}" 尚未注册`)
    return preset
  }

  list(): AgentPreset[] {
    return [...this.items.values()]
  }
}
