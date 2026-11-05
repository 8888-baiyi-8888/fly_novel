import type { Context } from '@deepseek-ai/cordis'
import type { SubagentProvider, SubagentStartRequest } from '@fly-novel/subagent'
import { startInProcessRun, type InProcessAgentCreator } from '@fly-novel/subagent-in-process-driver'

/** 由可信装配提供子 Agent 创建和释放能力。 */
export interface SpawnInProcessConfig {
  readonly create: InProcessAgentCreator
}

/** 在当前 Subagent 服务中注册 Spawn Provider，作用域关闭时注销。 */
export const spawnInProcessPlugin = Object.assign(function spawnInProcessPlugin(ctx: Context, config: SpawnInProcessConfig): void {
  if (typeof config?.create !== 'function') throw new Error('Spawn Provider 需要可信的创建函数')
  const provider: SubagentProvider = {
    name: 'spawn',
    supportsParameters: true,
    start(request: SubagentStartRequest) {
      const id = request.presetId
      if (typeof id !== 'string' || !id || id.trim() !== id) {
        throw new Error('Spawn 请求必须提供无首尾空白的 Preset ID')
      }
      return startInProcessRun(request, config.create)
    },
  }
  ctx.effect(() => ctx.subagents.registerProvider(provider))
}, { inject: ['subagents'] })

/** Spawn Provider 的 Harness 注册定义。 */
export const spawnInProcessPluginDefinition = {
  id: 'subagent-spawn-in-process', version: '1.0.0', description: '注册进程内 Spawn Provider', plugin: spawnInProcessPlugin,
}
