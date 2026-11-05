import { randomUUID } from 'node:crypto'
import { subagentRunId } from '@fly-novel/subagent'
import type { InProcessAgentCreator } from '@fly-novel/subagent-in-process-driver'
import type { AgentFramework } from '../core/bootstrap.js'
import { deepFreeze, snapshotJsonValue } from '@fly-novel/util'

/** 可信应用为允许委派的 Preset 提供的插件配置。 */
export type SpawnPresetConfigs = Readonly<Record<string, Readonly<Record<string, unknown>>>>

/**
 * 建立通过同一框架创建和释放子 Agent 的可信创建函数。
 * @param framework 同时拥有 Preset 注册表与 Manager 的框架。
 * @param presets 可委派的 Preset ID 及其可信插件配置；调用方须确认自定义插件不会恢复或共享会话。
 * @returns 供 Spawn Provider 使用的创建函数。
 * @throws 启动时 Preset、配置或 Agent 初始化无效时拒绝。
 */
export function createSpawnAgentCreator(framework: AgentFramework, presets: SpawnPresetConfigs): InProcessAgentCreator {
  return async request => {
    const presetId = request.presetId
    if (!presetId || presetId.trim() !== presetId) throw new Error('Spawn 请求必须提供有效的 Preset ID')
    const preset = framework.presets.get(presetId)
    if (!Object.hasOwn(presets, presetId)) throw new Error(`Preset "${presetId}" 未配置委派能力`)
    const pluginConfigs = presets[presetId]
    if (!pluginConfigs || !Object.hasOwn(pluginConfigs, 'agent-loop-runtime')) throw new Error(`Preset "${presetId}" 缺少 Agent Loop 配置`)
    if (!preset.plugins.some(binding => binding.pluginId === 'agent-loop-runtime')) throw new Error(`Preset "${presetId}" 未装配标准 Agent Loop`)
    const loop = pluginConfigs['agent-loop-runtime']
    if (!loop || typeof loop !== 'object' || !('provider' in loop) || typeof loop.provider !== 'string' || !loop.provider.trim() ||
        !('model' in loop) || typeof loop.model !== 'string' || !loop.model.trim()) {
      throw new Error(`Preset "${presetId}" 的 Agent Loop 配置无效`)
    }
    if (('sessionId' in loop && loop.sessionId !== undefined) || ('resumeSessionId' in loop && loop.resumeSessionId !== undefined)) {
      throw new Error('Spawn 不允许指定持久化 Session ID')
    }
    if (!Object.hasOwn(pluginConfigs, 'llm') || !pluginConfigs.llm) throw new Error(`Preset "${presetId}" 缺少 LLM 配置`)
    let parameters = request.parameters
    if (parameters !== undefined) {
      const snapshot = snapshotJsonValue(parameters)
      if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('子 Agent 创建参数必须是无损 JSON 对象')
      parameters = deepFreeze(snapshot)
    }
    const id = `subagent-${randomUUID()}`
    const runId = subagentRunId(randomUUID())
    const agent = await framework.manager.create({ id, presetId, ...(parameters === undefined ? {} : { parameters }), pluginConfigs: { ...pluginConfigs } })
    return { id: runId, agent, dispose: () => framework.manager.dispose(id) }
  }
}
