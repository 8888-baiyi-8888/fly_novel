import type { Context } from '@deepseek-ai/cordis'
import { AgentInstance } from '../core/agent.js'
import type {
  AgentInfo,
  ResolvedAgentPlugin,
} from '../core/contracts/agent.js'
import type { CreateAgentOptions } from '../core/contracts/preset.js'
import type { PluginRegistry, PresetRegistry } from '../core/preset.js'

/** 按 Preset 装配并初始化独立的 Harness Agent 实例；不持有已创建的实例。 */
export class AgentFactory {
  constructor(
    private readonly rootContext: Context,
    private readonly plugins: PluginRegistry,
    private readonly presets: PresetRegistry,
  ) {}

  /**
   * 解析插件配置，为插件提供的服务建立隔离 Context，并等待 Cordis 插件启动。
   * @param options Agent 标识、Preset ID 及可选的参数和插件配置覆盖值。
   * @returns 已完成初始化的 Agent 实例。
   * @throws Preset 或插件缺失、插件重复、缺少 agentLoop，或插件启动失败时抛错。
   */
  async create(options: CreateAgentOptions): Promise<AgentInstance> {
    if (!options.id.trim()) throw new Error('Agent ID 不能为空')

    const preset = this.presets.get(options.presetId)
    const pluginIds = new Set(preset.plugins.map((item) => item.pluginId))
    if (pluginIds.size !== preset.plugins.length) {
      throw new Error(`Preset "${preset.id}" 重复装配插件`)
    }
    const resolvedPlugins: ResolvedAgentPlugin[] = preset.plugins.map((binding) => {
      const definition = this.plugins.get(binding.pluginId)
      return {
        definition,
        config:
          (options.pluginConfigs && Object.hasOwn(options.pluginConfigs, definition.id)
            ? options.pluginConfigs[definition.id]
            : binding.config) ??
          definition.defaultConfig,
      }
    })

    const info: AgentInfo = {
      identity: {
        id: options.id,
        name: options.name?.trim() || options.id,
        role: preset.role,
      },
      presetId: preset.id,
      parameters: Object.freeze({
        ...(preset.defaultParameters ?? {}),
        ...(options.parameters ?? {}),
      }),
    }

    // 继承 bootstrap 根 Context 中的通用服务，
    // 同时为此 Agent 的插件服务建立独立隔离范围。
    let agentContext = this.rootContext.isolate('agent')
    const serviceNames = new Set(resolvedPlugins.flatMap(({ definition }) => {
      const provided = definition.plugin.provide
      return provided === undefined ? [] : Array.isArray(provided) ? provided : [provided]
    }))
    if (!serviceNames.has('agentLoop')) {
      throw new Error(`Preset "${preset.id}" 缺少 agentLoop 插件`)
    }

    for (const serviceName of serviceNames) {
      agentContext = agentContext.isolate(serviceName)
    }

    const agent = new AgentInstance(info, agentContext, resolvedPlugins)
    await agent.initialize()
    return agent
  }
}
