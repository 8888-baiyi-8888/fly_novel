import type {
  AgentPluginDefinition,
} from './contracts/agent.js'
import type { AgentPreset } from './contracts/preset.js'

/**
 * 按插件 ID 保存 Harness 可用的插件定义。
 *
 * 注册表负责检查插件标识并提供查询；插件依赖和服务由 Cordis 插件自身声明。
 */
export class PluginRegistry {
  private readonly items = new Map<string, AgentPluginDefinition>()

  /** 注册插件定义；ID 去除首尾空白，重复 ID、空 ID 或空版本会抛错。 */
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

  /** 按 ID 读取插件定义；未注册时抛错。 */
  get(id: string): AgentPluginDefinition {
    const definition = this.items.get(id)
    if (!definition) throw new Error(`插件 "${id}" 尚未注册`)
    return definition
  }

  /** 返回当前注册的插件定义列表。 */
  list(): AgentPluginDefinition[] {
    return [...this.items.values()]
  }

}

/**
 * 按 Preset ID 保存 Agent 的角色、默认参数和插件装配清单。
 *
 * 注册时复制默认参数和插件绑定，避免调用方后续修改原对象影响已注册的 Preset。
 */
export class PresetRegistry {
  private readonly items = new Map<string, AgentPreset>()

  /** 注册 Preset；ID 去除首尾空白，重复 ID、空 ID 或空版本会抛错。 */
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

  /** 按 ID 读取 Preset；未注册时抛错。 */
  get(id: string): AgentPreset {
    const preset = this.items.get(id)
    if (!preset) throw new Error(`Preset "${id}" 尚未注册`)
    return preset
  }

  /** 返回当前注册的 Preset 列表。 */
  list(): AgentPreset[] {
    return [...this.items.values()]
  }
}
