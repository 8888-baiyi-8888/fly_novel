import type { Context, Plugin } from '@deepseek-ai/cordis'

export type AgentRole = 'character' | 'director'
export type AgentParameters = Record<string, unknown>

export interface AgentIdentity {
  id: string
  name: string
  role: AgentRole
}

export interface AgentInfo {
  identity: AgentIdentity
  presetId: string
  parameters: Readonly<AgentParameters>
}

export interface AgentLoopInput {
  /** 本次 Turn 的用户输入文本。 */
  prompt: string
}

export interface AgentLoopResult {
  /** 成功完成的 Turn 返回给调用方的助手文本。 */
  content: string
}

/** Agent Loop 插件提供的执行服务契约。
 *
 * 每次 run 调用执行一个 Turn；成功时返回该 Turn 的助手文本，失败时拒绝并传播错误。
 */
export interface AgentLoop {
  run(input: AgentLoopInput): Promise<AgentLoopResult>
}

/** Agent handle 将执行请求交给当前实例装配的 Agent Loop 服务。 */
export interface Agent {
  readonly info: AgentInfo
  readonly context: Context
  readonly state: 'initializing' | 'ready' | 'disposing' | 'disposed' | 'failed'
  run(input: AgentLoopInput): Promise<AgentLoopResult>
  dispose(): Promise<void>
}

/** 项目使用的插件 ID、版本与默认配置；依赖和服务由 Cordis 插件声明。 */
export interface AgentPluginDefinition<TConfig = unknown> {
  id: string
  version: string
  description?: string
  plugin: Plugin<TConfig>
  defaultConfig?: TConfig
}

export interface ResolvedAgentPlugin {
  definition: AgentPluginDefinition
  config: unknown
}
