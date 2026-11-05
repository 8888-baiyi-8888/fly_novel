import type { Context } from '@deepseek-ai/cordis'
import { AgentLoopRuntime } from '@fly-novel/agent-loop'
import type { SessionEvent } from '@fly-novel/session'
import type { SubagentProvider, SubagentStartRequest } from '@fly-novel/subagent'
import { startInProcessRun, type InProcessAgentHandle } from '@fly-novel/subagent-in-process-driver'
import type {} from '@fly-novel/tools'

/** 可信创建方接收原始请求及本次启动时捕获的父会话历史。 */
export type ForkInProcessCreator = (request: SubagentStartRequest, history: readonly SessionEvent[]) => Promise<InProcessAgentHandle>

export interface ForkInProcessConfig { readonly create: ForkInProcessCreator }

/** 在父 Agent 作用域注册一次性 Fork Provider。 */
export const forkInProcessPlugin = Object.assign(function forkInProcessPlugin(ctx: Context, config: ForkInProcessConfig): void {
  if (typeof config?.create !== 'function') throw new Error('Fork Provider 需要可信的创建函数')
  const provider: SubagentProvider = {
    name: 'fork', supportsParameters: true,
    start(request) {
      if (!request.presetId || request.presetId.trim() !== request.presetId) throw new Error('Fork 请求必须提供有效的 Preset ID')
      const identity = ctx.get('agent')
      const loop = ctx.get('agentLoop')
      if (!identity || request.parent.info.identity.id !== identity.id || !ctx.subagents.belongsToAgent(identity) || !(loop instanceof AgentLoopRuntime) || !loop.ownsForkHistory(identity)) {
        throw new Error('Fork 需要同一父 Agent 作用域的身份与标准 Loop')
      }
      const history = loop.snapshotForkHistory()
      return startInProcessRun(request, value => config.create(value, history))
    },
  }
  ctx.effect(() => ctx.subagents.registerProvider(provider))
}, { inject: ['agent', 'agentLoop', 'subagents'] })

export const forkInProcessPluginDefinition = {
  id: 'subagent-fork-in-process', version: '1.0.0', description: '注册进程内 Fork Provider', plugin: forkInProcessPlugin,
}
