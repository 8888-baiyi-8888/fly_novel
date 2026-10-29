import { FiberState, type Context, type Fiber } from '@deepseek-ai/cordis'
import type {
  Agent as AgentHandle,
  AgentInfo,
  AgentLoopInput,
  AgentLoopResult,
  ResolvedAgentPlugin,
} from './contracts/agent.js'

export type AgentState = AgentHandle['state']

export class AgentInstance implements AgentHandle {
  readonly info: AgentInfo
  readonly context: Context

  private scope?: Fiber

  constructor(
    info: AgentInfo,
    context: Context,
    private readonly plugins: ResolvedAgentPlugin[],
  ) {
    this.info = info
    this.context = context
  }

  get state(): AgentState {
    switch (this.scope?.state) {
      case FiberState.ACTIVE: return 'ready'
      case FiberState.FAILED: return 'failed'
      case FiberState.UNLOADING: return 'disposing'
      case FiberState.DISPOSED: return 'disposed'
      default: return 'initializing'
    }
  }

  async initialize(): Promise<void> {
    try {
      let children: Fiber[] = []
      const scope = this.context.plugin((ctx) => {
        ctx.provide('agent', Object.freeze({ ...this.info.identity }))
        children = this.plugins.map((item) =>
          ctx.plugin(item.definition.plugin, item.config),
        )
      })
      this.scope = scope
      await scope
      let previousActive = -1
      while (true) {
        await Promise.all(children.map((child) => child.await()))
        const waiting = children.flatMap((child, index) => child.state === FiberState.ACTIVE ? [] : [this.plugins[index]!.definition.id])
        if (waiting.length === 0) break
        const active = children.length - waiting.length
        if (active <= previousActive) throw new Error(`插件依赖未就绪：${waiting.join('、')}`)
        previousActive = active
      }
    } catch (error) {
      try {
        await this.scope?.dispose()
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `Agent "${this.info.identity.id}" 初始化和清理失败`)
      }
      throw error
    }
  }

  async dispose(): Promise<void> {
    const errors: unknown[] = []
    try {
      await this.context.get('agentLoop')?.dispose()
    } catch (error) {
      errors.push(error)
    }
    try {
      await this.scope?.dispose()
    } catch (error) {
      errors.push(error)
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, `Agent "${this.info.identity.id}" 清理失败`)
  }

  cancel(): void {
    if (this.state !== 'ready') return
    this.context.get('agentLoop')?.cancel()
  }

  async run(input: AgentLoopInput): Promise<AgentLoopResult> {
    if (this.state !== 'ready') {
      throw new Error(`Agent "${this.info.identity.id}" 尚未就绪`)
    }
    const loop = this.context.get('agentLoop')
    if (!loop) {
      throw new Error(`Agent "${this.info.identity.id}" 的 agentLoop 服务不可用`)
    }
    return loop.run(input)
  }
}
