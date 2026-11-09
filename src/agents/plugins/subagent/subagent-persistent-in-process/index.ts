import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { subagentRunId, type SubagentProvider } from '@fly-novel/subagent'
import { startInProcessRun, type InProcessAgent, type InProcessAgentCreator } from '@fly-novel/subagent-in-process-driver'

/** 可信应用创建的 Agent 及其资源释放入口。 */
export interface PersistentAgentInstance {
  readonly agent: InProcessAgent
  dispose(): Promise<void>
}

/** 绑定一个可信身份及其 Preset；具体 Session 由创建方装配。 */
export interface PersistentAgentCreatorConfig {
  readonly presetId: string
  readonly sessionMode: 'create' | 'resume'
  create(input: { readonly sessionMode: 'create' | 'resume'; readonly initial: boolean }): Promise<PersistentAgentInstance>
}

/**
 * 建立绑定一个持续身份的可信创建函数；首次模式由配置指定，成功启动后使用 resume。
 * @param config Preset、首次会话模式与可信应用提供的创建及释放操作。
 * @returns 可用于 persistent Provider 的创建函数；同一创建函数的运行互斥。
 * @throws 配置无效、身份忙、请求包含创建参数或 Preset 不匹配时拒绝。
 */
export function createPersistentAgentCreator(config: PersistentAgentCreatorConfig): InProcessAgentCreator {
  if (!config.presetId || config.presetId.trim() !== config.presetId ||
      (config.sessionMode !== 'create' && config.sessionMode !== 'resume') || typeof config.create !== 'function') {
    throw new Error('持续子 Agent 创建配置无效')
  }
  const { presetId, create } = config
  let mode = config.sessionMode
  let initial = true
  let busy = false
  return async request => {
    if (request.presetId !== presetId || request.parameters !== undefined) throw new Error('持续子 Agent 的 Preset 或创建参数无效')
    if (busy) throw new Error('持续子 Agent 身份正在使用')
    request.signal.throwIfAborted()
    const runId = subagentRunId(randomUUID())
    busy = true
    let instance: PersistentAgentInstance
    try {
      instance = await create({ sessionMode: mode, initial })
    } catch (error) {
      // 聚合错误可能包含启动回滚失败，资源状态未知时不能重入。
      if (!(error instanceof AggregateError)) busy = false
      throw error
    }
    mode = 'resume'
    initial = false
    let disposal: Promise<void> | undefined
    return { id: runId, agent: instance.agent,
      dispose: () => disposal ??= (async () => { await instance.dispose(); busy = false })() }
  }
}

/**
 * 将多个可信持续身份按固定绑定名路由到各自的创建函数。
 * @param bindings 由应用提供的绑定名和创建函数；绑定名不来自模型授权。
 * @returns 可装配到同一 persistent Provider 的创建函数。
 */
export function createPersistentAgentRouter(bindings: Readonly<Record<string, InProcessAgentCreator>>): InProcessAgentCreator {
  const entries = Object.entries(bindings)
  if (!entries.length || entries.some(([id, create]) => !id || id.trim() !== id || typeof create !== 'function')) {
    throw new Error('持续子 Agent 路由配置无效')
  }
  const routes = new Map(entries)
  return async request => {
    const create = request.presetId && routes.get(request.presetId)
    if (!create || request.parameters !== undefined) throw new Error('持续子 Agent 绑定或创建参数无效')
    return create(request)
  }
}

/** 持续子 Agent Provider 由可信应用提供创建函数。 */
export interface PersistentInProcessConfig { readonly create: InProcessAgentCreator }

/** 注册 persistent Provider，作用域销毁时注销。 */
export const persistentInProcessPlugin = Object.assign(function persistentInProcessPlugin(ctx: Context, config: PersistentInProcessConfig): void {
  if (typeof config?.create !== 'function') throw new Error('持续子 Agent Provider 需要可信的创建函数')
  const provider: SubagentProvider = {
    name: 'persistent', supportsParameters: false,
    start(request) {
      if (!request.presetId || request.presetId.trim() !== request.presetId) throw new Error('持续子 Agent 请求必须提供有效的 Preset ID')
      return startInProcessRun(request, config.create)
    },
  }
  ctx.effect(() => ctx.subagents.registerProvider(provider))
}, { inject: ['subagents'] })

/** 持续子 Agent 的 Harness 插件注册定义。 */
export const persistentInProcessPluginDefinition = {
  id: 'subagent-persistent-in-process', version: '1.0.0', description: '注册进程内持续子 Agent Provider', plugin: persistentInProcessPlugin,
}
