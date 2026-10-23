import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, LlmRuntime } from '@fly-novel/llm'
import type { AgentPluginDefinition } from '../../core/contracts/agent.js'

export interface LlmPluginConfig {
  readonly adapters: readonly {
    readonly providers: readonly string[]
    readonly adapter: LlmAdapter
  }[]
}

/** 为当前 Agent 提供 LLM 服务；模型路由随插件作用域注销。 */
export const llmPlugin = Object.assign(function llmPlugin(ctx: Context, config: LlmPluginConfig): void {
  if (!config || !Array.isArray(config.adapters) || config.adapters.length === 0) {
    throw new Error('LLM 插件需要至少一个适配器配置')
  }
  for (const binding of config.adapters) {
    if (!binding || !Array.isArray(binding.providers) || binding.providers.length === 0 ||
        binding.providers.some((provider: unknown) => typeof provider !== 'string' || !provider.trim()) ||
        !(binding.adapter instanceof LlmAdapter)) {
      throw new Error('LLM 插件需要有效的供应商路由和适配器')
    }
  }

  const runtime = new LlmRuntime(ctx)
  for (const { providers, adapter } of config.adapters) {
    ctx.effect(() => runtime.registerAdapter(providers, adapter))
  }
}, { provide: 'llm' })

/** LLM 插件的 Harness 注册定义。 */
export const llmPluginDefinition: AgentPluginDefinition<LlmPluginConfig> = {
  id: 'llm',
  version: '1.0.0',
  description: '为 Agent 实例提供 LLM 服务',
  plugin: llmPlugin,
}
